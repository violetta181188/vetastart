const crypto = require('node:crypto');
const { exchangeLongLived, renewLongLived } = require('./meta-token');
const { loginMode, authorizationUrl } = require('./instagram-login');
const { connectUnified } = require('./unified-auth');
const { customerForRequest, validOrigin, bindAccount } = require('./customers');
const { requireAccountSlot } = require('./subscriptions');

function tokenKey(env) {
  const key = Buffer.from(env.VETASTART_TOKEN_KEY || '', 'base64');
  if (key.length !== 32) throw new Error('A 32-byte token encryption key is required');
  return key;
}

function seal(token, env) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', tokenKey(env), iv);
  const data = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
}

function unseal(value, env) {
  const bytes = Buffer.from(value, 'base64');
  const cipher = crypto.createDecipheriv('aes-256-gcm', tokenKey(env), bytes.subarray(0, 12));
  cipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8');
}

function initialize(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS instagram_connections (
    account_id TEXT PRIMARY KEY, token_cipher TEXT NOT NULL, expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS instagram_oauth_states (
    state_hash TEXT PRIMARY KEY, browser_hash TEXT NOT NULL, expires_at INTEGER NOT NULL
  );`);
  if (!db.prepare('PRAGMA table_info(instagram_oauth_states)').all().some(c => c.name === 'customer_id')) {
    db.exec('ALTER TABLE instagram_oauth_states ADD COLUMN customer_id TEXT');
  }
  const columns = db.prepare('PRAGMA table_info(instagram_connections)').all().map(c => c.name);
  for (const [name, definition] of [
    ['long_lived', 'INTEGER NOT NULL DEFAULT 0'], ['issued_at', 'INTEGER'],
    ['connection_status', "TEXT NOT NULL DEFAULT 'active'"],
    ['refresh_claim_until', 'INTEGER NOT NULL DEFAULT 0'],
    ['refresh_after', 'INTEGER NOT NULL DEFAULT 0'], ['last_refresh_error', 'TEXT'],
    ['token_mode', "TEXT NOT NULL DEFAULT 'instagram'"], ['business_id', 'TEXT'], ['config_id', 'TEXT']
  ]) {
    if (!columns.includes(name)) db.exec(`ALTER TABLE instagram_connections ADD COLUMN ${name} ${definition}`);
  }
}

function connectedToken(store, accountId, env, now = Date.now()) {
  initialize(store.db);
  const row = store.db.prepare('SELECT * FROM instagram_connections WHERE account_id = ?').get(accountId);
  if (!row || (row.expires_at <= now && !(row.token_mode === 'unified' && row.expires_at === 0)) ||
      row.connection_status !== 'active' || row.token_mode !== loginMode(env)) throw new Error('Instagram connection missing, expired or incompatible');
  return unseal(row.token_cipher, env);
}

async function refreshConnections(store, { env = process.env, fetchImpl = fetch, now = Date.now, accountId } = {}) {
  tokenKey(env);
  initialize(store.db);
  const counts = { refreshed: 0, skipped: 0, retry: 0, reauthorizationRequired: 0 };
  const rows = accountId
    ? store.db.prepare('SELECT * FROM instagram_connections WHERE account_id = ?').all(accountId)
    : store.db.prepare('SELECT * FROM instagram_connections').all();
  for (const row of rows) {
    const time = now();
    if (row.connection_status !== 'active') { counts.reauthorizationRequired++; continue; }
    if (row.expires_at <= time && !(row.token_mode === 'unified' && row.expires_at === 0)) {
      store.db.prepare(`UPDATE instagram_connections SET connection_status = 'reauthorization_required'
        WHERE account_id = ? AND token_cipher = ?`).run(row.account_id, row.token_cipher);
      counts.reauthorizationRequired++; continue;
    }
    if (row.token_mode === 'unified' || !row.long_lived || !row.issued_at || time - row.issued_at < 86400000 ||
        row.expires_at - time > 7 * 86400000 || row.refresh_after > time) {
      counts.skipped++; continue;
    }
    const claimed = store.db.prepare(`UPDATE instagram_connections SET refresh_claim_until = ?
      WHERE account_id = ? AND token_cipher = ? AND refresh_claim_until <= ? AND connection_status = 'active'`)
      .run(time + 60000, row.account_id, row.token_cipher, time);
    if (!claimed.changes) { counts.skipped++; continue; }
    try {
      const result = await renewLongLived(unseal(row.token_cipher, env), fetchImpl);
      const saved = store.db.prepare(`UPDATE instagram_connections SET token_cipher = ?, expires_at = ?,
        issued_at = ?, refresh_claim_until = 0, refresh_after = 0, last_refresh_error = NULL
        WHERE account_id = ? AND token_cipher = ? AND refresh_claim_until = ?`)
        .run(seal(result.accessToken, env), time + result.expiresIn * 1000,
          time, row.account_id, row.token_cipher, time + 60000);
      counts[saved.changes ? 'refreshed' : 'skipped']++;
    } catch (error) {
      const revoked = error.reauthorizationRequired === true;
      const changed = store.db.prepare(`UPDATE instagram_connections SET refresh_claim_until = 0,
        refresh_after = ?, last_refresh_error = ?, connection_status = ?
        WHERE account_id = ? AND token_cipher = ? AND refresh_claim_until = ?`)
        .run(time + 3600000, revoked ? 'reauthorization_required' : 'refresh_failed',
          revoked ? 'reauthorization_required' : 'active', row.account_id, row.token_cipher, time + 60000);
      counts[changed.changes ? (revoked ? 'reauthorizationRequired' : 'retry') : 'skipped']++;
    }
  }
  return counts;
}

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function secureEqual(a, b) {
  return typeof a === 'string' && typeof b === 'string' &&
    crypto.timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));
}

function authConfig(env) {
  const unified = loginMode(env) === 'unified';
  const redirect = new URL(env.INSTAGRAM_REDIRECT_URI);
  if (redirect.protocol !== 'https:' || redirect.username || redirect.password || redirect.search || redirect.hash ||
      redirect.pathname !== '/auth/instagram/callback' ||
      !/^\d+$/.test((unified ? env.META_APP_ID : env.INSTAGRAM_CLIENT_ID) || '') ||
      !(unified ? env.META_APP_SECRET : env.INSTAGRAM_CLIENT_SECRET) ||
      (env.VETASTART_ADMIN_TOKEN || '').length < 32 || !/^v\d+\.\d+$/.test(env.META_GRAPH_API_VERSION || '')) {
    throw new Error('Instagram OAuth configuration is incomplete');
  }
  tokenKey(env);
  loginMode(env);
  return { redirect: redirect.href };
}

function installInstagramAuth(app, { getStore, env, fetchImpl = fetch, now = Date.now }) {
  const cookieName = '__Secure-vetastart-instagram';
  const cookieOptions = { httpOnly: true, secure: true, sameSite: 'lax', path: '/auth/instagram', maxAge: 600000 };
  app.use(['/auth/instagram', '/connect/instagram'], (_req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY' });
    next();
  });
  app.get('/connect/instagram', (_req, res) => res.sendFile(require('node:path').join(__dirname, 'connect.html')));
  app.post('/auth/instagram/start', async (req, res) => {
    let config;
    try { config = authConfig(env); } catch { return res.sendStatus(503); }
    const supplied = req.get('Authorization') || '';
    let customer;
    try { customer = customerForRequest(req, getStore().db, now()); } catch { return res.sendStatus(503); }
    if (customer && !validOrigin(req, env)) return res.sendStatus(403);
    if (!customer && !secureEqual(supplied, `Bearer ${env.VETASTART_ADMIN_TOKEN}`)) return res.sendStatus(401);
    try {
      const db = getStore().db;
      initialize(db);
      db.prepare('DELETE FROM instagram_oauth_states WHERE expires_at <= ?').run(now());
      // Bound outstanding authorizations; do not invalidate other active browser flows.
      if (db.prepare('SELECT count(*) AS n FROM instagram_oauth_states').get().n >= 100) return res.sendStatus(429);
      const state = crypto.randomBytes(32).toString('hex');
      const browser = crypto.randomBytes(32).toString('hex');
      db.prepare(`INSERT INTO instagram_oauth_states (state_hash,browser_hash,expires_at,customer_id)
        VALUES (?, ?, ?, ?)`).run(hash(state), hash(browser), now() + 600000, customer?.id || null);
      const url = authorizationUrl(env, config.redirect, state);
      res.cookie(cookieName, browser, cookieOptions);
      return res.json({ authorizationUrl: url });
    } catch { return res.sendStatus(503); }
  });

  app.get('/auth/instagram/callback', async (req, res) => {
    res.clearCookie(cookieName, { ...cookieOptions, maxAge: undefined });
    const state = req.query.state;
    const browser = (req.get('Cookie') || '').split(';').map(s => s.trim())
      .find(s => s.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
    if (typeof state !== 'string' || !/^[a-f0-9]{64}$/.test(state) || !/^[a-f0-9]{64}$/.test(browser || '')) {
      return res.status(400).send('Неверный запрос подключения. Начните подключение заново.');
    }
    try {
      const config = authConfig(env);
      const db = getStore().db;
      initialize(db);
      const consumed = db.prepare(`DELETE FROM instagram_oauth_states
        WHERE state_hash = ? AND browser_hash = ? AND expires_at > ? RETURNING state_hash, customer_id`)
        .get(hash(state), hash(browser), now());
      if (!consumed) return res.status(400).send('Подключение истекло или уже использовано. Начните заново.');
      if (consumed.customer_id && customerForRequest(req, db, now())?.id !== consumed.customer_id) return res.sendStatus(401);
      if (req.query.error || typeof req.query.code !== 'string' || !req.query.code) {
        return res.status(400).send('Разрешение Instagram не получено. Можно начать подключение заново.');
      }
      if (loginMode(env) === 'unified') {
        const connection = await connectUnified(env, req.query.code, fetchImpl, now);
        db.exec('BEGIN IMMEDIATE');
        try {
        if(consumed.customer_id) requireAccountSlot(db,consumed.customer_id,connection.accountId,now());
        bindAccount(db, connection.accountId, consumed.customer_id);
        db.prepare(`INSERT INTO instagram_connections
          (account_id, token_cipher, expires_at, issued_at, token_mode, business_id, config_id)
          VALUES (?, ?, ?, ?, 'unified', ?, ?)
          ON CONFLICT(account_id) DO UPDATE SET token_cipher=excluded.token_cipher,
          expires_at=excluded.expires_at, issued_at=excluded.issued_at, token_mode='unified',
          business_id=excluded.business_id, config_id=excluded.config_id, long_lived=0,
          connection_status='active', refresh_claim_until=0, refresh_after=0, last_refresh_error=NULL`)
          .run(connection.accountId, seal(connection.accessToken, env), connection.expiresAt,
            connection.issuedAt, connection.businessId, connection.configId);
        db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
        return res.redirect(303, '/connect/instagram/success');
      }
      const request = async (url, options) => {
        const response = await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw new Error('Meta request failed');
        return response.json();
      };
      const exchange = await request('https://api.instagram.com/oauth/access_token', {
        method: 'POST', body: new URLSearchParams({ client_id: env.INSTAGRAM_CLIENT_ID,
          client_secret: env.INSTAGRAM_CLIENT_SECRET, grant_type: 'authorization_code',
          redirect_uri: config.redirect, code: req.query.code })
      });
      const token = exchange.access_token ? exchange : exchange.data?.[0];
      if (typeof token?.access_token !== 'string' || !token.access_token) throw new Error('Token missing');
      const issuedAt = now();
      const longLived = await exchangeLongLived(token.access_token, env.INSTAGRAM_CLIENT_SECRET, fetchImpl);
      // Customer onboarding is supported only by the Unified Login integration.
      if (consumed.customer_id) throw new Error('Customer accounts require Unified Login');
      const headers = { Authorization: `Bearer ${longLived.accessToken}` };
      const profile = await request(`https://graph.instagram.com/${env.META_GRAPH_API_VERSION}/me?fields=user_id,username`, { headers });
      if (typeof profile.user_id !== 'string' || !/^\d+$/.test(profile.user_id)) throw new Error('Account ID missing');
      if (env.INSTAGRAM_ACCOUNT_ID && profile.user_id !== env.INSTAGRAM_ACCOUNT_ID) throw new Error('Unexpected account');
      await request(`https://graph.instagram.com/${env.META_GRAPH_API_VERSION}/${profile.user_id}/subscribed_apps`, {
        method: 'POST', headers, body: new URLSearchParams({ subscribed_fields: 'messages' })
      }).then(result => { if (result.success !== true) throw new Error('Subscription failed'); });
      db.exec('BEGIN IMMEDIATE');
      try {
      bindAccount(db, profile.user_id, null);
      db.prepare(`INSERT INTO instagram_connections
        (account_id, token_cipher, expires_at, long_lived, issued_at) VALUES (?, ?, ?, 1, ?)
        ON CONFLICT(account_id) DO UPDATE SET token_cipher=excluded.token_cipher,
        expires_at=excluded.expires_at, long_lived=1, issued_at=excluded.issued_at,
        connection_status='active', refresh_claim_until=0, refresh_after=0, last_refresh_error=NULL,
        token_mode='instagram', business_id=NULL, config_id=NULL`)
        .run(profile.user_id, seal(longLived.accessToken, env), issuedAt + longLived.expiresIn * 1000, issuedAt);
      db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      // Drop code/state from the address bar; never echo tokens or account data.
      return res.redirect(303, '/connect/instagram/success');
    } catch {
      return res.status(502).send('Подключение не завершено. Проверьте настройки Meta и повторите вход.');
    }
  });
  app.get('/connect/instagram/success', (_req, res) => res.type('html').send(
    '<!doctype html><html lang="ru"><meta charset="utf-8"><title>Instagram</title><h1>Авторизация завершена</h1><p>Если вы только что подтвердили вход, соединение сохранено. Отправка включается отдельно. При отзыве доступа потребуется повторный вход.</p><a href="/connect/instagram">Вернуться</a></html>'
  ));
}

module.exports = { installInstagramAuth, connectedToken, refreshConnections, seal, unseal, initialize };
