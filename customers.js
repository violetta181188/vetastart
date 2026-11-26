const {buttonTables, parseButtons, validateButtons, buttonFileError, validFileId, sendPdf} = require('./message-buttons');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const scrypt = promisify(crypto.scrypt);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const cookieName = 'vetastart_session';
const { startTrial, access } = require('./subscriptions');
const { START_OFFER, selectStartPlan } = require('./subscriptions');
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
  db.exec(buttonTables);
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
  return db.prepare(`SELECT r.*, b.buttons AS message_buttons,b.require_follow FROM customer_rules r JOIN customer_accounts a
    ON a.account_id=r.account_id AND a.customer_id=r.customer_id
    LEFT JOIN rule_message_options b ON b.rule_id=r.id ORDER BY r.id`).all().map(r => ({
    id: r.id, accountId: r.account_id, trigger: 'message', keyword: r.keyword, reply: r.reply, messageButtons: r.message_buttons, requireFollow: Boolean(r.require_follow), enabled: !!r.enabled
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
  router.use((req, res, next) => {
    try { req.db = getStore().db; initializeCustomers(req.db); req.customer = customerForRequest(req, req.db, now()); next(); }
    catch { res.sendStatus(503); }
  });
  const standardJson = express.json({limit: '8kb'});
  const ruleJson = express.json({limit: '9mb', inflate: false});
  router.use((req, res, next) => {
    const savesRule = (req.method === 'POST' && /^\/rules\/?$/i.test(req.path)) ||
      (req.method === 'PATCH' && /^\/rules\/[^/]+\/?$/i.test(req.path));
    if (!savesRule) return standardJson(req, res, next);
    if (!req.customer) return res.sendStatus(401);
    return ruleJson(req, res, next);
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
    res.json({enabled,isTest,plans:[START_OFFER],invoices});
  });
  router.post('/billing/checkout',(req,res)=>{
    const planId = req.body?.planId === START_OFFER.id ? selectStartPlan(req.body.accounts) : null;
    if (!planId) return res.sendStatus(400);
    try {res.json(createCheckout(req.db,req.customer.id,planId,env,now()));}
    catch {res.sendStatus(503);}
  });
  router.post('/logout', (req, res) => {
    const token = (req.get('Cookie') || '').split(';').map(s => s.trim()).find(s => s.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
    if (token) req.db.prepare('DELETE FROM customer_sessions WHERE session_hash=?').run(hash(token));
    res.clearCookie(cookieName, { path: '/' }); res.json({ ok: true });
  });
  router.get('/accounts', (req, res) => res.json(req.db.prepare('SELECT account_id FROM customer_accounts WHERE customer_id=?').all(req.customer.id)));
  router.get('/legacy-projects',(_req,res)=>res.json([]));
  router.get('/rules', (req, res) => {
    const rows = req.db.prepare(`SELECT r.id,r.account_id,r.keyword,r.reply,r.enabled,b.buttons AS message_buttons,b.require_follow,
      (SELECT COUNT(DISTINCT d.recipient_id) FROM drafts d WHERE d.scenario_id=r.id AND d.account_id=r.account_id) AS contacts,
      (SELECT COUNT(DISTINCT d.recipient_id) FROM drafts d WHERE d.scenario_id=r.id AND d.account_id=r.account_id AND d.status='sent') AS sent_contacts,
      (SELECT MAX(d.created_at) FROM drafts d WHERE d.scenario_id=r.id AND d.account_id=r.account_id) AS last_run
      FROM customer_rules r LEFT JOIN rule_message_options b ON b.rule_id=r.id WHERE r.customer_id=?`).all(req.customer.id);
    res.json(rows.map(({message_buttons, require_follow, ...rule}) => ({...rule, buttons: parseButtons(message_buttons), requireFollow: Boolean(require_follow)})));
  });
  router.get('/activity', (req, res) => res.json(req.db.prepare(`SELECT d.id,d.account_id,d.status,d.created_at
    FROM drafts d JOIN customer_accounts a ON a.account_id=d.account_id
    WHERE a.customer_id=? ORDER BY d.created_at DESC,d.id LIMIT 50`).all(req.customer.id)));
  function ruleTransaction(req, action) {
    req.db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      req.db.exec('COMMIT');
      return result;
    } catch (error) {
      req.db.exec('ROLLBACK');
      throw error;
    }
  }
  function saveMessageOptions(db, ruleId, payload, requireFollow) {
    for (const file of payload.files) {
      db.prepare('INSERT INTO rule_message_files (id,rule_id,filename,content,size_bytes) VALUES (?,?,?,?,?)')
        .run(file.id, ruleId, file.filename, file.content, file.content.length);
    }
    db.prepare(`INSERT INTO rule_message_options (rule_id,buttons,require_follow) VALUES (?,?,?)
      ON CONFLICT(rule_id) DO UPDATE SET buttons=excluded.buttons, require_follow=excluded.require_follow
    `).run(ruleId, JSON.stringify(payload.buttons), Number(requireFollow));
  }
  function validRuleText(keyword, reply) {
    return typeof keyword === 'string' && keyword.trim() && keyword.length <= 100 &&
      typeof reply === 'string' && reply.trim() && reply.length <= 1000;
  }
  router.post('/rules', (req, res) => {
    const {accountId, keyword, reply, enabled = false, buttons = [], requireFollow = false} = req.body || {};
    if (typeof accountId !== 'string' || !validRuleText(keyword, reply) || typeof enabled !== 'boolean' || typeof requireFollow !== 'boolean') return res.sendStatus(400);
    const payload = validateButtons(buttons, reply);
    if (!payload || buttonFileError(payload, [])) return res.status(400).json({error: 'invalid_buttons'});
    const result = ruleTransaction(req, () => {
      if (!req.db.prepare('SELECT 1 FROM customer_accounts WHERE customer_id=? AND account_id=?')
        .get(req.customer.id, accountId)) return {status: 403};
      const entitlement = access(req.db, req.customer.id, now());
      if (!entitlement.active) return {status: 402};
      const count = (req.db.prepare('SELECT count(*) AS n FROM customer_rules WHERE customer_id=?').get(req.customer.id)).n;
      if (count >= entitlement.limits.rules) return {status: 409, error: 'rule_limit_reached'};
      const id = crypto.randomUUID();
      req.db.prepare('INSERT INTO customer_rules VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, req.customer.id, accountId, keyword.trim(), reply.trim(), Number(enabled));
      if (payload.buttons.length || requireFollow) saveMessageOptions(req.db, id, payload, requireFollow);
      return {status: 201, id};
    });
    if (result.id) return res.status(201).json({id: result.id});
    if (result.error) return res.status(result.status).json({error: result.error});
    res.sendStatus(result.status);
  });
  router.patch('/rules/:id', (req, res) => {
    const {keyword, reply, enabled, buttons, requireFollow} = req.body || {};
    const changesReply = keyword !== undefined || reply !== undefined || buttons !== undefined;
    if (typeof enabled !== 'boolean' || (changesReply && !validRuleText(keyword, reply)) ||
        (requireFollow !== undefined && typeof requireFollow !== 'boolean')) return res.sendStatus(400);
    const payload = buttons === undefined ? undefined : validateButtons(buttons, reply);
    if (payload === null) return res.status(400).json({error: 'invalid_buttons'});
    const result = ruleTransaction(req, () => {
      if (enabled && !(access(req.db, req.customer.id, now())).active) return {status: 402};
      const rule = req.db.prepare(`SELECT r.id, b.buttons, b.require_follow FROM customer_rules r
        LEFT JOIN rule_message_options b ON b.rule_id=r.id WHERE r.id=? AND r.customer_id=?`)
        .get(req.params.id, req.customer.id);
      if (!rule) return {status: 404};
      if (payload) {
        const files = req.db.prepare('SELECT id,size_bytes FROM rule_message_files WHERE rule_id=?').all(rule.id);
        const error = buttonFileError(payload, files);
        if (error) return {status: 400, error};
      } else if (changesReply && reply.trim().length > 640 && parseButtons(rule.buttons).length) {
        return {status: 400, error: 'invalid_buttons'};
      }
      if (payload || requireFollow !== undefined) {
        saveMessageOptions(req.db, rule.id, payload ?? {buttons: parseButtons(rule.buttons), files: []},
          requireFollow ?? Boolean(rule.require_follow));
      }
      if (changesReply) {
        req.db.prepare('UPDATE customer_rules SET keyword=?, reply=?, enabled=? WHERE id=? AND customer_id=?')
          .run(keyword.trim(), reply.trim(), Number(enabled), rule.id, req.customer.id);
      } else {
        req.db.prepare('UPDATE customer_rules SET enabled=? WHERE id=? AND customer_id=?')
          .run(Number(enabled), rule.id, req.customer.id);
      }
      return {status: 204};
    });
    if (result.error) return res.status(result.status).json({error: result.error});
    res.sendStatus(result.status);
  });
  router.post('/rules/preview', (req, res) => {
    const {accountId, phrase} = req.body || {};
    if (typeof accountId !== 'string' || typeof phrase !== 'string' ||
        !phrase.trim() || phrase.length > 1000) return res.sendStatus(400);
    const rules = req.db.prepare(
      `SELECT r.id, r.keyword, r.reply, b.buttons, b.require_follow FROM customer_rules r LEFT JOIN rule_message_options b ON b.rule_id=r.id
       WHERE r.customer_id=? AND r.account_id=? AND r.enabled=1 ORDER BY r.id`
    ).all(req.customer.id, accountId);
    const {findMatchingRule} = require('./keyword-match');
    const rule = findMatchingRule(rules, phrase);
    if (!rule) return res.json({matches: []});
    const {require_follow, ...preview} = rule;
    res.json({matches: [{...preview, buttons: parseButtons(rule.buttons), requireFollow: Boolean(require_follow)}]});
  });
  router.delete('/rules/:id', (req, res) => {
    const result = req.db.prepare('DELETE FROM customer_rules WHERE id=? AND customer_id=?').run(req.params.id, req.customer.id);
    res.sendStatus(result.changes ? 204 : 404);
  });
  router.use((_req, res) => res.sendStatus(404));
  router.use((error, _req, res, _next) => res.sendStatus(error.status === 413 ? 413 : 400));
  app.get('/automation-files/:id', (req, res) => {
    if (!validFileId(req.params.id)) return res.sendStatus(404);
    const db = getStore().db;
    initializeCustomers(db);
    const file = db.prepare(`SELECT f.filename,f.content FROM rule_message_files f
      JOIN customer_rules r ON r.id=f.rule_id WHERE f.id=?`).get(req.params.id);
    return sendPdf(res, file);
  });
  app.use('/api/customer', router);
  app.get('/app', (_req, res) => res.sendFile(require('node:path').join(__dirname, 'dashboard.html')));
}

module.exports = { installCustomers, initializeCustomers, customerForRequest, validOrigin, bindAccount, customerRules };
