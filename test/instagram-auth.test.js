const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server');
const { AutomationStore } = require('../automation');
const { connectedToken, seal, unseal } = require('../instagram-auth');
const { sendDrafts } = require('../sender');

const clock = Date.now();
const env = { INSTAGRAM_CLIENT_ID: '123', INSTAGRAM_CLIENT_SECRET: 'test-client-secret',
  INSTAGRAM_REDIRECT_URI: 'https://vetastart.example/auth/instagram/callback',
  VETASTART_ADMIN_TOKEN: 'test-admin-key-that-is-at-least-32-characters',
  VETASTART_TOKEN_KEY: Buffer.alloc(32, 7).toString('base64'), META_GRAPH_API_VERSION: 'v99.0',
  INSTAGRAM_ACCOUNT_ID: '456' };

async function setup(t, { config = env, fetchImpl, now = () => clock } = {}) {
  const store = new AutomationStore(':memory:');
  const calls = [];
  const fake = fetchImpl || (async (url, init) => {
    calls.push({ url, init });
    if (url === 'https://api.instagram.com/oauth/access_token') {
      assert.equal(init.body.get('client_secret'), env.INSTAGRAM_CLIENT_SECRET);
      return Response.json({ access_token: 'private-token-never-in-html', expires_in: 3600 });
    }
    if (url.startsWith('https://graph.instagram.com/access_token?')) {
      const parsed = new URL(url);
      assert.equal(parsed.searchParams.get('grant_type'), 'ig_exchange_token');
      assert.equal(parsed.searchParams.get('client_secret'), env.INSTAGRAM_CLIENT_SECRET);
      return Response.json({ access_token: 'private-token-never-in-html', expires_in: 60 * 86400 });
    }
    if (url.includes('/me?')) return Response.json({ user_id: '456', username: 'test-user' });
    return Response.json({ success: true });
  });
  const app = createApp({ store, env: config, fetchImpl: fake, now });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function start() {
    const response = await fetch(base + '/auth/instagram/start', { method: 'POST',
      headers: { Authorization: `Bearer ${env.VETASTART_ADMIN_TOKEN}` } });
    assert.equal(response.status, 200);
    const url = new URL((await response.json()).authorizationUrl);
    assert.equal(url.origin, config.INSTAGRAM_LOGIN_MODE === 'unified' ? 'https://www.facebook.com' : 'https://www.instagram.com');
    assert.match(response.headers.get('set-cookie'), /HttpOnly/);
    assert.match(response.headers.get('set-cookie'), /Secure/);
    assert.match(response.headers.get('set-cookie'), /SameSite=Lax/);
    return { state: url.searchParams.get('state'), cookie: response.headers.get('set-cookie').split(';')[0] };
  }
  async function callback(flow, query = 'code=test-code') {
    return fetch(base + '/auth/instagram/callback?state=' + flow.state + '&' + query,
      { headers: { Cookie: flow.cookie }, redirect: 'manual' });
  }
  return { store, calls, base, start, callback };
}

test('official OAuth redirect, browser-bound state, encrypted persistence and sender integration', async t => {
  const { store, calls, start, callback } = await setup(t);
  const flow = await start();
  const response = await callback(flow);
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/connect/instagram/success');
  assert.equal(calls.length, 4);
  assert.equal(calls[3].init.body.get('subscribed_fields'), 'messages');
  const row = store.db.prepare('SELECT * FROM instagram_connections').get();
  assert.ok(!row.token_cipher.includes('private-token'));
  assert.equal(connectedToken(store, '456', env, clock), 'private-token-never-in-html');
  assert.equal(row.long_lived, 1);
  assert.throws(() => connectedToken(store, '456', env, clock + 60 * 86400000 + 1));
  const replay = await callback(flow);
  assert.equal(replay.status, 400);
  assert.equal(calls.length, 4);
  // Feed a real local scenario, then confirm the sender can decrypt the connection.
  const payload = { object: 'instagram', entry: [{ id: '456', messaging: [{ timestamp: clock,
    sender: { id: '789' }, recipient: { id: '456' }, message: { mid: 'm1', text: 'ГАЙД' } }] }] };
  store.receive(Buffer.from(JSON.stringify(payload)), payload);
  store.process([{ id: 'guide', accountId: '456', trigger: 'message', keyword: 'гайд', reply: 'Готово' }]);
  const result = await sendDrafts(store, { env: { ...env, VETASTART_SEND_ENABLED: 'true' }, now: () => clock + 1000,
    fetchImpl: async (_url, init) => {
      assert.equal(init.headers.Authorization, 'Bearer private-token-never-in-html');
      return Response.json({ message_id: 'sent' });
    } });
  assert.equal(result.sent, 1);
});

test('start requires admin authentication and configured HTTPS callback', async t => {
  const { base } = await setup(t);
  assert.equal((await fetch(base + '/auth/instagram/start', { method: 'POST' })).status, 401);
  const misconfigured = await setup(t, { config: { ...env, INSTAGRAM_REDIRECT_URI: 'http://invalid/auth/instagram/callback' } });
  assert.equal((await fetch(misconfigured.base + '/auth/instagram/start', { method: 'POST' })).status, 503);
  const page = await fetch(base + '/connect/instagram');
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.match(await page.text(), /Продолжить в Instagram/);
});

test('wrong browser, expired state, denied permission and missing code never exchange credentials', async t => {
  let time = clock;
  const { start, callback, calls } = await setup(t, { now: () => time });
  const flow = await start();
  const other = await start();
  assert.equal((await callback({ ...flow, cookie: other.cookie })).status, 400);
  assert.equal((await callback(flow, 'error=access_denied')).status, 400);
  assert.equal((await callback(flow)).status, 400);
  assert.equal((await callback(other, '')).status, 400);
  const expired = await start(); time += 600001;
  assert.equal((await callback(expired)).status, 400);
  assert.equal(calls.length, 0);
});

test('provider failure cannot save a connection or disclose credentials in the error page', async t => {
  const { store, start, callback } = await setup(t, { fetchImpl: async () => {
    throw new Error('sensitive-provider-token');
  } });
  const response = await callback(await start());
  assert.equal(response.status, 502);
  assert.ok(!(await response.text()).includes('sensitive-provider-token'));
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM instagram_connections').get().n, 0);
});

test('encryption rejects altered ciphertext and wrong keys', () => {
  const encrypted = seal('test-token', env);
  const bytes = Buffer.from(encrypted, 'base64'); bytes[bytes.length - 1] ^= 1;
  assert.throws(() => unseal(bytes.toString('base64'), env));
  assert.throws(() => unseal(encrypted, { VETASTART_TOKEN_KEY: Buffer.alloc(32, 8).toString('base64') }));
  assert.throws(() => seal('test-token', {}));
});

test('wrong account and failed message subscription do not persist credentials', async t => {
  for (const failure of ['wrong-account', 'subscription']) {
    const { store, start, callback } = await setup(t, { fetchImpl: async url => {
      if (url.includes('oauth/access_token')) return Response.json({ access_token: 'test-token' });
      if (url.startsWith('https://graph.instagram.com/access_token?')) return Response.json({ access_token: 'long-token', expires_in: 60 * 86400 });
      if (url.includes('/me?')) return Response.json({ user_id: failure === 'wrong-account' ? '999' : '456' });
      return Response.json({ success: false });
    } });
    assert.equal((await callback(await start())).status, 502);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM instagram_connections').get().n, 0);
  }
});

test('Unified callback fails closed without Meta business settings', async t => {
  const { start, callback, store } = await setup(t, {
    config: { ...env, META_APP_ID: '123', META_APP_SECRET: 'test-secret', INSTAGRAM_LOGIN_MODE: 'unified', INSTAGRAM_CONFIG_ID: '1674463687685006' },
    fetchImpl: () => assert.fail('legacy token endpoint must not be called')
  });
  const flow = await start();
  const response = await callback(flow);
  assert.equal(response.status, 502);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM instagram_connections').get().n, 0);
  assert.equal((await callback(flow)).status, 400);
});
