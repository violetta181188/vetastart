const crypto = require('node:crypto');
const DAY = 86400000;
const {PLANS, START_OFFER, selectStartPlan, isPlanPayment} = require('../subscriptions');
async function initializeSubscriptions(db) {
  await db.exec(`CREATE TABLE IF NOT EXISTS subscription_periods (
    id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, plan_id TEXT NOT NULL,
    start_at INTEGER NOT NULL, end_at INTEGER NOT NULL, payment_id TEXT UNIQUE,
    status TEXT NOT NULL DEFAULT 'active'
  );
  CREATE INDEX IF NOT EXISTS subscription_customer ON subscription_periods(customer_id,start_at,end_at);
  CREATE UNIQUE INDEX IF NOT EXISTS subscription_one_trial ON subscription_periods(customer_id) WHERE plan_id='trial';
  CREATE TABLE IF NOT EXISTS subscription_usage (
    draft_id TEXT PRIMARY KEY, period_id TEXT NOT NULL, attempted_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS subscription_usage_period ON subscription_usage(period_id);`);
}
async function startTrial(db, customerId, now = Date.now()) {
  await initializeSubscriptions(db);
  await db.prepare(`INSERT OR IGNORE INTO subscription_periods
    (id,customer_id,plan_id,start_at,end_at) VALUES (?,?,'trial',?,?)`).run(crypto.randomUUID(), customerId, now, now + PLANS.trial.days * DAY);
}
async function access(db, customerId, now = Date.now()) {
  await initializeSubscriptions(db);
  const period = await db.prepare(`SELECT * FROM subscription_periods WHERE customer_id=?
    AND status='active' AND start_at<=? AND end_at>? ORDER BY start_at DESC LIMIT 1`).get(customerId, now, now);
  if (!period || !PLANS[period.plan_id]) return {
    active: false,
    status: 'subscription_required'
  };
  const used = (await db.prepare('SELECT count(*) AS n FROM subscription_usage WHERE period_id=?').get(period.id)).n;
  const plan = PLANS[period.plan_id];
  return {
    active: true,
    status: period.plan_id === 'trial' ? 'trial' : 'active',
    planId: period.plan_id,
    title: plan.title,
    periodId: period.id,
    startAt: period.start_at,
    endAt: period.end_at,
    limits: {
      accounts: plan.accounts,
      rules: plan.rules,
      rulesPerAccount: !!plan.rulesPerAccount,
      messages: plan.messages
    },
    usedMessages: used
  };
}
async function applyVerifiedPayment(db, {customerId, paymentId, planId, amount, currency, status}, now = Date.now()) {
  await initializeSubscriptions(db);
  const plan = PLANS[planId];
  if (!isPlanPayment(planId, amount) || status !== 'succeeded' || currency !== 'RUB' || typeof paymentId !== 'string' || !paymentId || !await db.prepare('SELECT id FROM customers WHERE id=?').get(customerId)) {
    throw new Error('Confirmed payment does not match server plan');
  }
  return await db.transaction(async () => {
    const existing = await db.prepare('SELECT * FROM subscription_periods WHERE payment_id=?').get(paymentId);
    if (existing) {
      if (existing.customer_id !== customerId || existing.plan_id !== planId) throw new Error('Payment already assigned');
      return {
        duplicate: true
      };
    }
    const tail = (await db.prepare("SELECT max(end_at) AS end_at FROM subscription_periods WHERE customer_id=? AND status='active'").get(customerId)).end_at;
    const start = Math.max(now, tail || 0);
    await db.prepare(`INSERT INTO subscription_periods (id,customer_id,plan_id,start_at,end_at,payment_id)
      VALUES (?,?,?,?,?,?)`).run(crypto.randomUUID(), customerId, planId, start, start + plan.days * DAY, paymentId);
    return {
      duplicate: false
    };
  });
}
async function requireAccountSlot(db, customerId, accountId, now = Date.now()) {
  const entitlement = await access(db, customerId, now);
  if (!entitlement.active) throw new Error('Subscription required');
  if (await db.prepare('SELECT 1 FROM customer_accounts WHERE customer_id=? AND account_id=?').get(customerId, accountId)) return;
  const count = (await db.prepare('SELECT count(*) AS n FROM customer_accounts WHERE customer_id=?').get(customerId)).n;
  if (count >= entitlement.limits.accounts) throw new Error('Account limit reached');
}
async function reserveSend(db, customerId, draftId, now = Date.now()) {
  await initializeSubscriptions(db);
  return await db.transaction(async () => {
    const entitlement = await access(db, customerId, now);
    if (!entitlement.active || (entitlement.limits.messages !== null && entitlement.usedMessages >= entitlement.limits.messages)) {
      return false;
    }
    const draft = await db.prepare('SELECT account_id,scenario_id FROM drafts WHERE id=?').get(draftId);
    const accounts = await db.prepare('SELECT account_id FROM customer_accounts WHERE customer_id=? ORDER BY rowid LIMIT ?').all(customerId, entitlement.limits.accounts);
    if (!draft || !accounts.some(account => account.account_id === draft.account_id)) return false;
    const ruleAccountId = entitlement.limits.rulesPerAccount ? draft.account_id : null;
    const rules = await db.prepare(`SELECT id,enabled FROM customer_rules
      WHERE customer_id=? AND account_id=COALESCE(?, account_id) ORDER BY rowid LIMIT ?`)
      .all(customerId, ruleAccountId, entitlement.limits.rules);
    if (!rules.some(rule => rule.id === draft.scenario_id && rule.enabled)) return false;
    const claim = await db.prepare(`UPDATE drafts SET status='sending',attempted_at=?,failure_code=NULL WHERE id=? AND status='draft'
      AND account_id IN (SELECT account_id FROM customer_accounts WHERE customer_id=?)`).run(new Date(now).toISOString(), draftId, customerId);
    if (claim.changes) await db.prepare('INSERT INTO subscription_usage VALUES (?,?,?)').run(draftId, entitlement.periodId, now);
    return !!claim.changes;
  });
}
module.exports = {
  PLANS,
  START_OFFER,
  selectStartPlan,
  initializeSubscriptions,
  startTrial,
  access,
  applyVerifiedPayment,
  requireAccountSlot,
  reserveSend
};
