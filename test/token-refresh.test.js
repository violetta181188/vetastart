const { test } = require('node:test');
const assert = require('node:assert/strict');
const { AutomationStore } = require('../automation');
const { initialize, seal, connectedToken, refreshConnections } = require('../instagram-auth');
const { exchangeLongLived } = require('../meta-token');
const env = { VETASTART_TOKEN_KEY: Buffer.alloc(32, 1).toString('base64') };
const day = 86400000, time = 1800000000000;
function setup(t, { issuedAt = time - 55 * day, expiresAt = time + 5 * day, longLived = 1 } = {}) {
  const store = new AutomationStore(':memory:'); initialize(store.db);
  store.db.prepare(`INSERT INTO instagram_connections
    (account_id, token_cipher, expires_at, issued_at, long_lived) VALUES ('123', ?, ?, ?, ?)`)
    .run(seal('old-token', env), expiresAt, issuedAt, longLived);
  t.after(() => store.close()); return store;
}
const opts = fetchImpl => ({ env, fetchImpl, now: () => time });

test('refreshes a due long-lived token and encrypts it; subsequent pass makes no request', async t => {
  const store = setup(t);
  const result = await refreshConnections(store, opts(async (url, init) => {
    const parsed = new URL(url);
    assert.equal(parsed.origin, 'https://graph.instagram.com');
    assert.equal(parsed.pathname, '/refresh_access_token');
    assert.equal(parsed.searchParams.get('grant_type'), 'ig_refresh_token');
    assert.equal(parsed.searchParams.get('access_token'), 'old-token');
    assert.equal(init.redirect, 'error');
    return Response.json({ access_token: 'renewed-token', expires_in: 60 * 86400 });
  }));
  assert.equal(result.refreshed, 1);
  assert.equal(connectedToken(store, '123', env, time), 'renewed-token');
  assert.equal(store.db.prepare('SELECT expires_at FROM instagram_connections').get().expires_at, time + 60 * day);
  assert.equal((await refreshConnections(store, opts(() => assert.fail('too soon')))).skipped, 1);
});

test('skips young, not-due and legacy short-lived tokens', async t => {
  for (const source of [{ issuedAt: time - 1000, expiresAt: time + day },
    { expiresAt: time + 20 * day }, { longLived: 0 }]) {
    const store = setup(t, source);
    assert.equal((await refreshConnections(store, opts(() => assert.fail('ineligible refresh')))).skipped, 1);
  }
});

test('expired or revoked tokens require reauthorization and cannot be used by sender', async t => {
  const expired = setup(t, { expiresAt: time });
  assert.equal((await refreshConnections(expired, opts(() => assert.fail('expired refresh')))).reauthorizationRequired, 1);
  const revoked = setup(t);
  const result = await refreshConnections(revoked, opts(async () => Response.json({ error: { code: 190 } }, { status: 400 })));
  assert.equal(result.reauthorizationRequired, 1);
  assert.throws(() => connectedToken(revoked, '123', env, time));
  assert.equal((await refreshConnections(revoked, opts(() => assert.fail('revoked retry')))).reauthorizationRequired, 1);
});

test('temporary outage preserves usable token and backs off for an hour', async t => {
  const store = setup(t);
  const result = await refreshConnections(store, opts(async () => { throw new Error('sensitive-url-token'); }));
  assert.equal(result.retry, 1);
  assert.equal(connectedToken(store, '123', env, time), 'old-token');
  assert.equal((await refreshConnections(store, opts(() => assert.fail('backoff')))).skipped, 1);
  const row = store.db.prepare('SELECT * FROM instagram_connections').get();
  assert.equal(row.last_refresh_error, 'refresh_failed');
  assert.equal(row.refresh_after, time + 3600000);
});

test('competing refresh is skipped and newly authorized connection cannot be overwritten', async t => {
  const store = setup(t);
  const result = await refreshConnections(store, opts(async () => {
    assert.equal((await refreshConnections(store, opts(() => assert.fail('parallel refresh')))).skipped, 1);
    store.db.prepare("UPDATE instagram_connections SET token_cipher = ?, refresh_claim_until = 0 WHERE account_id = '123'")
      .run(seal('new-authorization-token', env));
    return Response.json({ access_token: 'stale-refreshed-token', expires_in: 60 * 86400 });
  }));
  assert.equal(result.skipped, 1);
  assert.equal(connectedToken(store, '123', env, time), 'new-authorization-token');
});

test('invalid exchange/refresh responses fail closed without leaking provider diagnostics', async t => {
  for (const body of [{ access_token: 'short', expires_in: 3600 }, { access_token: 'missing-expiry' },
    { expires_in: 60 * 86400 }]) {
    await assert.rejects(exchangeLongLived('short-token', 'secret', async () => Response.json(body)), /Invalid long-lived/);
  }
  await assert.rejects(exchangeLongLived('short-token', 'secret', async () => { throw new Error('sensitive-token'); }),
    error => !error.message.includes('sensitive-token'));
  const store = setup(t);
  assert.equal((await refreshConnections(store, opts(async () => Response.json({ access_token: 'bad' })))).retry, 1);
  assert.equal(connectedToken(store, '123', env, time), 'old-token');
});
