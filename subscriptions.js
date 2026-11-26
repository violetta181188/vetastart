const crypto = require('node:crypto');
const DAY = 86400000;
const START = Object.freeze({
  title: 'Старт', days: 30, price: 59000, accounts: 1, rules: 5, messages: null,
  availableForCheckout: true
});
const EXTRA_ACCOUNT_PRICE = 10000;
const MAX_START_ACCOUNTS = 10;
const START_OFFER = Object.freeze({
  id: 'start', title: START.title, days: START.days, price: START.price, accounts: START.accounts,
  rules: START.rules, messages: START.messages, extraAccountPrice: EXTRA_ACCOUNT_PRICE, maxAccounts: MAX_START_ACCOUNTS
});

function selectStartPlan(accounts = 1) {
  if (!Number.isSafeInteger(accounts) || accounts < 1 || accounts > MAX_START_ACCOUNTS) return null;
  return accounts === 1 ? 'start' : 'start_' + accounts;
}

const additionalAccountPlans = Object.fromEntries(
  Array.from({length: MAX_START_ACCOUNTS - 1}, (_, index) => {
    const accounts = index + 2;
    return [selectStartPlan(accounts), Object.freeze({
      ...START, accounts, price: START.price + (accounts - 1) * EXTRA_ACCOUNT_PRICE
    })];
  })
);

const PLANS = Object.freeze({
  trial: { title:'Пробный', days:7, price:0, accounts:1, rules:3, messages:100 },
  start: START,
  ...additionalAccountPlans,
  // Preserve the limits and payment handling for previously issued plans.
  business: { title:'Бизнес', days:30, price:249000, accounts:3, rules:20, messages:null },
  pro: { title:'PRO', days:30, price:499000, accounts:10, rules:100, messages:null }
});

function isPlanPayment(planId, amount) {
  if (!Object.hasOwn(PLANS, planId) || planId === 'trial' || !Number.isSafeInteger(amount)) return false;
  // Old Start invoices had their own immutable amount.
  return amount === PLANS[planId].price || (planId === 'start' && amount === 99000);
}

function initializeSubscriptions(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS subscription_periods (
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

function startTrial(db, customerId, now = Date.now()) {
  initializeSubscriptions(db);
  db.prepare(`INSERT OR IGNORE INTO subscription_periods
    (id,customer_id,plan_id,start_at,end_at) VALUES (?,?,'trial',?,?)`)
    .run(crypto.randomUUID(), customerId, now, now + PLANS.trial.days * DAY);
}

function access(db, customerId, now = Date.now()) {
  initializeSubscriptions(db);
  const period = db.prepare(`SELECT * FROM subscription_periods WHERE customer_id=?
    AND status='active' AND start_at<=? AND end_at>? ORDER BY start_at DESC LIMIT 1`).get(customerId,now,now);
  if (!period || !PLANS[period.plan_id]) return { active:false, status:'subscription_required' };
  const used = db.prepare('SELECT count(*) AS n FROM subscription_usage WHERE period_id=?').get(period.id).n;
  const plan = PLANS[period.plan_id];
  return {active:true,status:period.plan_id==='trial'?'trial':'active',planId:period.plan_id,
    title:plan.title,periodId:period.id,startAt:period.start_at,endAt:period.end_at,
    limits:{accounts:plan.accounts,rules:plan.rules,messages:plan.messages},usedMessages:used};
}

// Internal entry point only. Provider adapters must authenticate the result per
// their protocol before invoking it. No customer-facing route accepts grants.
function applyVerifiedPayment(db, { customerId, paymentId, planId, amount, currency, status }, now = Date.now()) {
  initializeSubscriptions(db);
  const plan=PLANS[planId];
  if (!isPlanPayment(planId,amount) || status!=='succeeded' || currency!=='RUB' ||
      typeof paymentId!=='string' || !paymentId || !db.prepare('SELECT id FROM customers WHERE id=?').get(customerId)) {
    throw new Error('Confirmed payment does not match server plan');
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const existing=db.prepare('SELECT * FROM subscription_periods WHERE payment_id=?').get(paymentId);
    if(existing) {
      if(existing.customer_id!==customerId || existing.plan_id!==planId) throw new Error('Payment already assigned');
      db.exec('COMMIT');return {duplicate:true};
    }
    const tail=db.prepare("SELECT max(end_at) AS end_at FROM subscription_periods WHERE customer_id=? AND status='active'").get(customerId).end_at;
    const start=Math.max(now,tail||0);
    db.prepare(`INSERT INTO subscription_periods (id,customer_id,plan_id,start_at,end_at,payment_id)
      VALUES (?,?,?,?,?,?)`).run(crypto.randomUUID(),customerId,planId,start,start+plan.days*DAY,paymentId);
    db.exec('COMMIT');return {duplicate:false};
  } catch(error) {db.exec('ROLLBACK');throw error;}
}

function requireAccountSlot(db, customerId, accountId, now = Date.now()) {
  const entitlement=access(db,customerId,now);
  if(!entitlement.active) throw new Error('Subscription required');
  if(db.prepare('SELECT 1 FROM customer_accounts WHERE customer_id=? AND account_id=?').get(customerId,accountId)) return;
  const count=db.prepare('SELECT count(*) AS n FROM customer_accounts WHERE customer_id=?').get(customerId).n;
  if(count>=entitlement.limits.accounts) throw new Error('Account limit reached');
}

function reserveSend(db, customerId, draftId, now = Date.now()) {
  initializeSubscriptions(db);
  db.exec('BEGIN IMMEDIATE');
  try {
    const entitlement=access(db,customerId,now);
    if(!entitlement.active || (entitlement.limits.messages !== null && entitlement.usedMessages >= entitlement.limits.messages)) {
      db.exec('COMMIT');return false;
    }
    const draft=db.prepare('SELECT account_id,scenario_id FROM drafts WHERE id=?').get(draftId);
    const accounts=db.prepare('SELECT account_id FROM customer_accounts WHERE customer_id=? ORDER BY rowid LIMIT ?')
      .all(customerId,entitlement.limits.accounts);
    const rules=db.prepare('SELECT id,enabled FROM customer_rules WHERE customer_id=? ORDER BY rowid LIMIT ?')
      .all(customerId,entitlement.limits.rules);
    if(!draft || !accounts.some(a=>a.account_id===draft.account_id) || !rules.some(r=>r.id===draft.scenario_id&&r.enabled)) {
      db.exec('COMMIT');return false;
    }
    const claim=db.prepare(`UPDATE drafts SET status='sending',attempted_at=?,failure_code=NULL WHERE id=? AND status='draft'
      AND account_id IN (SELECT account_id FROM customer_accounts WHERE customer_id=?)`)
      .run(new Date(now).toISOString(),draftId,customerId);
    if(claim.changes) db.prepare('INSERT INTO subscription_usage VALUES (?,?,?)').run(draftId,entitlement.periodId,now);
    db.exec('COMMIT');return !!claim.changes;
  } catch(error) {db.exec('ROLLBACK');throw error;}
}

module.exports={PLANS,START_OFFER,selectStartPlan,isPlanPayment,initializeSubscriptions,startTrial,access,applyVerifiedPayment,requireAccountSlot,reserveSend};
