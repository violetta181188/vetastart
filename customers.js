const crypto = require('node:crypto');
const { promisify } = require('node:util');
const scrypt = promisify(crypto.scrypt);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const cookieName = 'vetastart_session';
const { startTrial, access } = require('./subscriptions');
const { PLANS } = require('./subscriptions');
const { initializeBilling,config:billingConfig,createCheckout } = require('./robokassa');
const {initializeRecovery,developmentAuth,recoveryService}=require('./account-recovery');

function initializeCustomers(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS customers (
    id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, salt TEXT NOT NULL, password_hash TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS customer_sessions (
    session_hash TEXT PRIMARY KEY, customer_id TEXT NOT NULL, expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS customer_accounts (
    account_id TEXT PRIMARY KEY, customer_id TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS customer_rules (
    id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, account_id TEXT NOT NULL,
    keyword TEXT NOT NULL, reply TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS customer_login_limits (
    key TEXT PRIMARY KEY, attempts INTEGER NOT NULL, expires_at INTEGER NOT NULL
  );`);
  if(!db.prepare('PRAGMA table_info(customers)').all().some(c=>c.name==='email_verified_at'))
    db.exec('ALTER TABLE customers ADD COLUMN email_verified_at INTEGER');
  initializeRecovery(db);
}

function customerForRequest(req, db, now = Date.now()) {
  initializeCustomers(db);
  const token = (req.get('Cookie') || '').split(';').map(s => s.trim())
    .find(s => s.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  return db.prepare(`SELECT c.id, c.email FROM customer_sessions s JOIN customers c ON c.id=s.customer_id
    WHERE s.session_hash=? AND s.expires_at>? AND c.email_verified_at IS NOT NULL`).get(hash(token), now) || null;
}

function validOrigin(req, env) {
  try {
    const origin = new URL(env.VETASTART_PUBLIC_ORIGIN);
    return (origin.protocol === 'https:' || (origin.protocol === 'http:' && ['127.0.0.1','localhost'].includes(origin.hostname))) &&
      origin.origin === env.VETASTART_PUBLIC_ORIGIN && req.get('Origin') === origin.origin;
  } catch { return false; }
}

function bindAccount(db, accountId, customerId) {
  initializeCustomers(db);
  const owner = db.prepare('SELECT customer_id FROM customer_accounts WHERE account_id=?').get(accountId);
  if (owner && owner.customer_id !== customerId) throw new Error('Account already belongs to another customer');
  if (customerId) db.prepare('INSERT OR IGNORE INTO customer_accounts VALUES (?, ?)').run(accountId, customerId);
}

function customerRules(db) {
  initializeCustomers(db);
  return db.prepare(`SELECT r.* FROM customer_rules r JOIN customer_accounts a
    ON a.account_id=r.account_id AND a.customer_id=r.customer_id`).all().map(r => ({
    id: r.id, accountId: r.account_id, trigger: 'message', keyword: r.keyword, reply: r.reply, enabled: !!r.enabled
  }));
}

function installCustomers(app, { getStore, env, now = Date.now, sendMail }) {
  const recovery=recoveryService({env,now,sendMail});
  const express = require('express');
  const router = express.Router();
  router.use((_req, res, next) => { res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); next(); });
  router.use((req, res, next) => {
    if (!['GET', 'HEAD'].includes(req.method) && !validOrigin(req, env)) return res.sendStatus(403);
    next();
  });
  router.use(express.json({ limit: '8kb' }));
  router.use((req, res, next) => {
    try { req.db = getStore().db; initializeCustomers(req.db); req.customer = customerForRequest(req, req.db, now()); next(); }
    catch { res.sendStatus(503); }
  });
  function session(res, db, customerId) {
    const token = crypto.randomBytes(32).toString('hex');
    const ttl = 7 * 86400000;
    db.prepare('DELETE FROM customer_sessions WHERE expires_at<=?').run(now());
    db.prepare('INSERT INTO customer_sessions VALUES (?, ?, ?)').run(hash(token), customerId, now() + ttl);
    const origin = new URL(env.VETASTART_PUBLIC_ORIGIN);
    if (origin.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(origin.hostname)) throw new Error('HTTPS required');
    res.cookie(cookieName, token, { httpOnly: true, secure: origin.protocol === 'https:', sameSite: 'lax', path: '/', maxAge: ttl });
  }
  router.post(['/register', '/login'], async (req, res) => {
    try {
      const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
      const password = req.body?.password;
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 ||
          typeof password !== 'string' || password.length < 12 || password.length > 256) return res.sendStatus(400);
      const key = hash(req.ip || 'unknown');
      req.db.prepare('DELETE FROM customer_login_limits WHERE expires_at<=?').run(now());
      req.db.prepare(`INSERT INTO customer_login_limits VALUES (?,1,?)
        ON CONFLICT(key) DO UPDATE SET attempts=attempts+1`).run(key, now() + 900000);
      if (req.db.prepare('SELECT attempts FROM customer_login_limits WHERE key=?').get(key).attempts > 20) return res.sendStatus(429);
      const user = req.db.prepare('SELECT * FROM customers WHERE email=?').get(email);
      if (req.path === '/register') {
        if (env.VETASTART_SIGNUP_ENABLED !== 'true') return res.sendStatus(403);
        if (user) return res.status(409).json({ error: 'Не удалось создать аккаунт. Попробуйте войти.' });
        const dev=developmentAuth(env);
        if(!dev)recovery.ensureMailer();
        const salt = crypto.randomBytes(16).toString('hex');
        const digest = await scrypt(password, salt, 64);
        const id = crypto.randomUUID();
        req.db.exec('BEGIN IMMEDIATE');
        try {
        req.db.prepare('INSERT INTO customers (id,email,salt,password_hash,email_verified_at) VALUES (?,?,?,?,?)')
          .run(id,email,salt,digest.toString('hex'),dev?now():null);
        if(dev){startTrial(req.db,id,now());session(res,req.db,id);}
        req.db.exec('COMMIT');
        } catch(error) { req.db.exec('ROLLBACK');throw error; }
        if(!dev){await recovery.issue(req.db,{id,email},'verify',req.ip||'unknown');return res.status(202).json({ok:true,verificationRequired:true});}
      } else {
        const digest = await scrypt(password, user?.salt || 'invalid-user-salt', 64);
        if (!user || !crypto.timingSafeEqual(digest, Buffer.from(user.password_hash, 'hex'))) return res.sendStatus(401);
        if(user.email_verified_at===null)return res.status(403).json({error:'email_verification_required'});
        session(res, req.db, user.id);
      }
      res.json({ ok: true });
    } catch { res.sendStatus(503); }
  });
  recovery.install(router);
  router.use((req, res, next) => req.customer ? next() : res.sendStatus(401));
  router.get('/me', (req, res) => res.json({ email: req.customer.email, subscription: access(req.db,req.customer.id,now()) }));
  router.get('/billing', (req,res)=>{
    initializeBilling(req.db);
    let enabled=false,isTest=true;
    try {const config=billingConfig(env);enabled=true;isTest=config.isTest;} catch {}
    const invoices=req.db.prepare(`SELECT id,plan_id,amount,is_test,status,created_at FROM robokassa_invoices
      WHERE customer_id=? ORDER BY id DESC LIMIT 20`).all(req.customer.id);
    res.json({enabled,isTest,plans:Object.entries(PLANS).filter(([id])=>id!=='trial').map(([id,p])=>({id,title:p.title,
      price:p.price,days:p.days,accounts:p.accounts,rules:p.rules,messages:p.messages})),invoices});
  });
  router.post('/billing/checkout',(req,res)=>{
    if(!Object.hasOwn(PLANS,req.body?.planId)||req.body.planId==='trial') return res.sendStatus(400);
    try {res.json(createCheckout(req.db,req.customer.id,req.body.planId,env,now()));}
    catch {res.sendStatus(503);}
  });
  router.post('/logout', (req, res) => {
    const token = (req.get('Cookie') || '').split(';').map(s => s.trim()).find(s => s.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
    if (token) req.db.prepare('DELETE FROM customer_sessions WHERE session_hash=?').run(hash(token));
    res.clearCookie(cookieName, { path: '/' }); res.json({ ok: true });
  });
  router.get('/accounts', (req, res) => res.json(req.db.prepare('SELECT account_id FROM customer_accounts WHERE customer_id=?').all(req.customer.id)));
  router.get('/rules', (req, res) => res.json(req.db.prepare('SELECT id,account_id,keyword,reply,enabled FROM customer_rules WHERE customer_id=?').all(req.customer.id)));
  router.get('/activity', (req, res) => res.json(req.db.prepare(`SELECT d.id,d.account_id,d.status,d.created_at
    FROM drafts d JOIN customer_accounts a ON a.account_id=d.account_id
    WHERE a.customer_id=? ORDER BY d.created_at DESC,d.id LIMIT 50`).all(req.customer.id)));
  router.post('/rules', (req, res) => {
    const { accountId, keyword, reply, enabled = false } = req.body || {};
    if (typeof accountId !== 'string' || typeof keyword !== 'string' || !keyword.trim() || keyword.length > 100 ||
        typeof reply !== 'string' || !reply.trim() || reply.length > 1000 || typeof enabled !== 'boolean') return res.sendStatus(400);
    if (!req.db.prepare('SELECT 1 FROM customer_accounts WHERE customer_id=? AND account_id=?').get(req.customer.id, accountId)) return res.sendStatus(403);
    req.db.exec('BEGIN IMMEDIATE');
    try {
    const entitlement=access(req.db,req.customer.id,now());
    if(!entitlement.active) {req.db.exec('COMMIT');return res.status(402).json({error:'subscription_required'});}
    const count=req.db.prepare('SELECT count(*) AS n FROM customer_rules WHERE customer_id=?').get(req.customer.id).n;
    if(count>=entitlement.limits.rules) {req.db.exec('COMMIT');return res.status(409).json({error:'rule_limit_reached'});}
    const id = crypto.randomUUID();
    req.db.prepare('INSERT INTO customer_rules VALUES (?, ?, ?, ?, ?, ?)').run(id, req.customer.id, accountId, keyword.trim(), reply.trim(), Number(enabled));
    req.db.exec('COMMIT');
    res.status(201).json({ id });
    } catch(error) {req.db.exec('ROLLBACK');throw error;}
  });
  router.delete('/rules/:id', (req, res) => {
    const result = req.db.prepare('DELETE FROM customer_rules WHERE id=? AND customer_id=?').run(req.params.id, req.customer.id);
    res.sendStatus(result.changes ? 204 : 404);
  });
  router.use((_req, res) => res.sendStatus(404));
  router.use((_error, _req, res, _next) => res.sendStatus(400));
  app.use('/api/customer', router);
  app.get('/app', (_req, res) => res.sendFile(require('node:path').join(__dirname, 'dashboard.html')));
}

module.exports = { installCustomers, initializeCustomers, customerForRequest, validOrigin, bindAccount, customerRules };
