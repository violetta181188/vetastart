const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, statSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { AutomationStore, matches, validateRules } = require('../automation');
const { createApp } = require('../server');

const rule = { id: 'guide', accountId: 'account', trigger: 'message', keyword: 'гайд', reply: 'Ваш материал' };
function payload(mid = 'm1', text = 'Пришлите ГАЙД!') {
  return { object: 'instagram', entry: [{ id: 'account', messaging: [
    { sender: { id: 'visitor' }, recipient: { id: 'account' }, message: { mid, text } }
  ] }] };
}
function receive(store, event) { return store.receive(Buffer.from(JSON.stringify(event)), event); }

test('delivery and message deduplication survive restart; drafts are created exactly once locally', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vetastart-'));
  const filename = path.join(dir, 'automation.sqlite');
  let store = new AutomationStore(filename);
  try {
    assert.deepEqual(receive(store, payload()), { duplicate: false });
    assert.deepEqual(receive(store, payload()), { duplicate: true });
    const retry = payload(); retry.entry[0].time = 999;
    receive(store, retry);
    store.close(); store = new AutomationStore(filename);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM events').get().n, 1);
    assert.deepEqual(store.process([rule]), { processed: 1, drafts: 1 });
    assert.deepEqual(store.process([rule]), { processed: 0, drafts: 0 });
    assert.equal(store.db.prepare('SELECT text FROM drafts').get().text, rule.reply);
    assert.equal(statSync(filename).mode & 0o777, 0o600);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('Unicode keywords match whole words and phrases, not substrings or regex expressions', () => {
  assert.ok(matches('Хочу ГАЙД!', 'гайд'));
  assert.ok(matches('да, хочу гайд!', 'хочу гайд'));
  assert.ok(matches('код a+b!', 'a+b'));
  assert.equal(matches('гайдлайн', 'гайд'), false);
  assert.equal(matches('другой код', 'a+b'), false);
});

test('account isolation, disabled scenarios, echoes, unsupported events, comments', () => {
  const store = new AutomationStore(':memory:');
  try {
    const event = payload();
    event.entry[0].messaging.push(null, { message: { is_echo: true, mid: 'echo', text: 'гайд' } });
    event.entry[0].changes = [{ field: 'comments', value: { id: 'c1', from: { id: 'visitor' }, text: 'ГАЙД' } }];
    receive(store, event);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM events').get().n, 2);
    assert.deepEqual(store.process([{ ...rule, accountId: 'other' },
      { ...rule, id: 'disabled', enabled: false },
      { ...rule, id: 'comment', trigger: 'comment' }]), { processed: 2, drafts: 1 });
    assert.equal(store.db.prepare('SELECT scenario_id FROM drafts').get().scenario_id, 'comment');
    assert.throws(() => validateRules([rule, rule]));
    assert.throws(() => validateRules([{ ...rule, keyword: '' }]));
  } finally { store.close(); }
});

test('failed inbox transaction rolls back delivery, allowing Meta retry', () => {
  const store = new AutomationStore(':memory:');
  try {
    store.db.exec("CREATE TRIGGER reject_event BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'test'); END;");
    assert.throws(() => receive(store, payload()));
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM deliveries').get().n, 0);
    store.db.exec('DROP TRIGGER reject_event');
    assert.deepEqual(receive(store, payload()), { duplicate: false });
  } finally { store.close(); }
});

test('webhook authenticates raw payload, persists before acknowledgement and preserves verification', async t => {
  const store = new AutomationStore(':memory:');
  const app = createApp({ store, env: { META_APP_SECRET: 'test-secret', INSTAGRAM_VERIFY_TOKEN: 'test-verify' } });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const body = JSON.stringify(payload());
  async function post(body, valid = true) {
    const signature = crypto.createHmac('sha256', 'test-secret').update(body).digest('hex');
    return fetch(base + '/webhooks/instagram', { method: 'POST', body,
      headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': valid ? `sha256=${signature}` : 'invalid' } });
  }
  assert.equal((await post(body, false)).status, 403);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM deliveries').get().n, 0);
  assert.equal((await post('{')).status, 400);
  assert.equal((await post('{"object":"other","entry":[]}')).status, 400);
  assert.equal(await (await post(body)).text(), 'EVENT_RECEIVED');
  assert.equal((await post(body)).status, 200);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM events').get().n, 1);
  const verified = await fetch(base + '/webhooks/instagram?hub.mode=subscribe&hub.verify_token=test-verify&hub.challenge=123');
  assert.equal(verified.status, 200); assert.equal(await verified.text(), '123');
  assert.equal((await fetch(base + '/webhooks/instagram?hub.mode=subscribe&hub.verify_token=bad&hub.challenge=123')).status, 403);
  assert.match(await (await fetch(base)).text(), /VetaStart/);
});

test('persistence failure returns 503; no false acknowledgement', async t => {
  const app = createApp({ env: { META_APP_SECRET: 'test-secret' }, store: { receive() { throw new Error('disk unavailable'); } } });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const body = JSON.stringify(payload());
  const response = await fetch(`http://127.0.0.1:${server.address().port}/webhooks/instagram`, {
    method: 'POST', body, headers: { 'Content-Type': 'application/json',
      'x-hub-signature-256': 'sha256=' + crypto.createHmac('sha256', 'test-secret').update(body).digest('hex') }
  });
  assert.equal(response.status, 503);
});
