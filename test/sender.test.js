const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { AutomationStore } = require('../automation');
const { sendDrafts } = require('../sender');

const timestamp = 1800000000000;
const env = { VETASTART_SEND_ENABLED: 'true', INSTAGRAM_ACCOUNT_ID: '123',
  INSTAGRAM_ACCESS_TOKEN: 'test-only-token', META_GRAPH_API_VERSION: 'v99.0' };
function seed(store, { account = '123', time = timestamp, comment = false } = {}) {
  const entry = { id: account };
  if (comment) entry.changes = [{ field: 'comments', value: { id: 'c1', from: { id: '456' }, text: 'ГАЙД' } }];
  else entry.messaging = [{ timestamp: time, sender: { id: '456' }, recipient: { id: account },
    message: { mid: 'm1', text: 'ГАЙД' } }];
  const payload = { object: 'instagram', entry: [entry] };
  store.receive(Buffer.from(JSON.stringify(payload)), payload);
  store.process([{ id: 'guide', accountId: account, trigger: comment ? 'comment' : 'message', keyword: 'ГАЙД', reply: 'Ваш гайд' }]);
}
function options(fetchImpl) { return { env, now: () => timestamp + 1000, fetchImpl }; }

test('sender sends expected request, records Meta confirmation and does not resend after restart', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vetastart-sender-'));
  const filename = path.join(dir, 'db.sqlite');
  let store = new AutomationStore(filename), calls = 0;
  try {
    seed(store);
    const fetchImpl = async (url, init) => {
      calls++;
      assert.equal(url, 'https://graph.instagram.com/v99.0/123/messages');
      assert.equal(init.headers.Authorization, 'Bearer test-only-token');
      assert.equal(init.redirect, 'error');
      assert.deepEqual(JSON.parse(init.body), { recipient: { id: '456' }, message: { text: 'Ваш гайд' } });
      return new Response(JSON.stringify({ message_id: 'confirmed-id' }), { status: 200 });
    };
    assert.deepEqual(await sendDrafts(store, options(fetchImpl)), { sent: 1, failed: 0, unknown: 0, blocked: 0 });
    store.close(); store = new AutomationStore(filename);
    await sendDrafts(store, options(fetchImpl));
    assert.equal(calls, 1);
    assert.equal(store.db.prepare('SELECT message_id FROM drafts').get().message_id, 'confirmed-id');
  } finally { store.close(); rmSync(dir, { force: true, recursive: true }); }
});

test('disabled or incomplete configuration leaves drafts untouched and never calls Meta', async () => {
  const store = new AutomationStore(':memory:');
  try {
    seed(store);
    for (const config of [{}, { ...env, VETASTART_SEND_ENABLED: 'false' }, { ...env, INSTAGRAM_ACCESS_TOKEN: '' },
      { ...env, META_GRAPH_API_VERSION: '../invalid' }]) {
      await assert.rejects(sendDrafts(store, { env: config, fetchImpl: () => assert.fail('unexpected network') }));
    }
    assert.equal(store.db.prepare('SELECT status FROM drafts').get().status, 'draft');
  } finally { store.close(); }
});

test('timeouts, server errors and malformed confirmations are held and never retried automatically', async () => {
  for (const fetchImpl of [async () => { throw new Error('timeout'); },
    async () => new Response('{}', { status: 503 }),
    async () => new Response('invalid-json', { status: 200 }),
    async () => new Response('{}', { status: 200 })]) {
    const store = new AutomationStore(':memory:');
    try {
      seed(store);
      assert.equal((await sendDrafts(store, options(fetchImpl))).unknown, 1);
      await sendDrafts(store, options(() => assert.fail('unexpected retry')));
      assert.equal(store.db.prepare('SELECT status FROM drafts').get().status, 'unknown');
    } finally { store.close(); }
  }
});

test('rejected token or throttling are recorded without retry or storing provider error text', async () => {
  for (const status of [400, 401, 403, 429]) {
    const store = new AutomationStore(':memory:');
    try {
      seed(store);
      const result = await sendDrafts(store, options(async () => new Response('{"error":"sensitive text"}', { status })));
      assert.equal(result.failed, 1);
      assert.equal(store.db.prepare('SELECT failure_code FROM drafts').get().failure_code, `http_${status}`);
      await sendDrafts(store, options(() => assert.fail('unexpected retry')));
    } finally { store.close(); }
  }
});

test('expired, future, missing timestamps and comment private replies are blocked', async () => {
  for (const source of [{ time: timestamp - 24 * 60 * 60 * 1000 }, { time: null },
    { time: timestamp + 10000 }, { comment: true }]) {
    const store = new AutomationStore(':memory:');
    try {
      seed(store, source);
      assert.equal((await sendDrafts(store, options(() => assert.fail('ineligible send')))).blocked, 1);
    } finally { store.close(); }
  }
});

test('sender only handles configured account and competing workers cannot claim the same draft', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vetastart-concurrent-'));
  const filename = path.join(dir, 'db.sqlite');
  const first = new AutomationStore(filename), second = new AutomationStore(filename);
  try {
    seed(first); seed(first, { account: '789' });
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      // First claim is durable before this network request begins.
      assert.equal((await sendDrafts(second, options(() => assert.fail('duplicate send')))).sent, 0);
      return new Response('{"message_id":"ok"}', { status: 200 });
    };
    assert.equal((await sendDrafts(first, options(fetchImpl))).sent, 1);
    assert.equal(calls, 1);
    assert.equal(first.db.prepare("SELECT status FROM drafts WHERE account_id = '789'").get().status, 'draft');
  } finally { first.close(); second.close(); rmSync(dir, { force: true, recursive: true }); }
});

test('a claim left by a crashed process is held for reconciliation rather than resent', async () => {
  const store = new AutomationStore(':memory:');
  try {
    seed(store);
    store.db.exec("UPDATE drafts SET status = 'sending'");
    assert.equal((await sendDrafts(store, options(() => assert.fail('crash retry')))).sent, 0);
    assert.equal(store.db.prepare('SELECT status FROM drafts').get().status, 'sending');
  } finally { store.close(); }
});
