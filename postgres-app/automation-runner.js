const {outboundScope} = require('./outbound-scope');
const path = require('node:path');
const {AutomationStore} = require('./automation');
const {processPending} = require('./worker');
const {sendDrafts} = require('./sender');
const {initialize} = require('./instagram-auth');
const {initializeCustomers} = require('./customers');
const {pollOwnerInbox}=require('./api-poller');
async function runCycle(store, {env = process.env, fetchImpl = fetch, now = Date.now} = {}) {
  const result = {
    processed: 0,
    drafts: 0,
    accounts: 0,
    accountErrors: 0,
    sent: 0,
    failed: 0,
    unknown: 0,
    blocked: 0
  };
  if (env.VETASTART_AUTOMATION_ENABLED !== 'true') return result;
  Object.assign(result,await pollOwnerInbox(store,{env,fetchImpl,now}));
  Object.assign(result, await processPending(store, {
    env
  }));
  if (env.VETASTART_SEND_ENABLED !== 'true') return result;
  const scope = outboundScope(env);
  await initialize(store.db);
  await initializeCustomers(store.db);
  await store.db.exec(`CREATE TABLE IF NOT EXISTS automation_account_runs (
    account_id TEXT PRIMARY KEY, last_run_at INTEGER NOT NULL, status TEXT NOT NULL
  )`);
  const accounts = await store.db.prepare(`SELECT c.account_id,c.token_mode,c.config_id FROM instagram_connections c
    LEFT JOIN customer_accounts a ON a.account_id=c.account_id
    LEFT JOIN automation_account_runs r ON r.account_id=c.account_id
    WHERE c.connection_status='active' AND (a.customer_id IS NOT NULL OR
      EXISTS (SELECT 1 FROM operator_rules o WHERE o.account_id=c.account_id AND o.enabled=1))
    ${scope ? 'AND c.account_id = ?' : ''}
    ORDER BY COALESCE(r.last_run_at,0),c.account_id LIMIT 25`).all(...(scope ? [scope.accountId] : []));
  for (const account of accounts) {
    await store.db.prepare(`INSERT INTO automation_account_runs VALUES (?,?,'running')
      ON CONFLICT(account_id) DO UPDATE SET last_run_at=excluded.last_run_at,status='running'`).run(account.account_id, now());
    try {
      const tenantEnv = {
        ...env,
        INSTAGRAM_ACCESS_TOKEN: undefined,
        INSTAGRAM_ACCOUNT_ID: account.account_id,
        INSTAGRAM_LOGIN_MODE: account.token_mode,
        INSTAGRAM_CONFIG_ID: account.config_id || env.INSTAGRAM_CONFIG_ID
      };
      const sent = await sendDrafts(store, {
        env: tenantEnv,
        fetchImpl,
        now,
        limit: 20
      });
      for (const key of ['sent', 'failed', 'unknown', 'blocked']) result[key] += sent[key];
      result.accounts++;
      await store.db.prepare("UPDATE automation_account_runs SET status='completed' WHERE account_id=?").run(account.account_id);
    } catch {
      result.accountErrors++;
      await store.db.prepare("UPDATE automation_account_runs SET status='configuration_error' WHERE account_id=?").run(account.account_id);
    }
  }
  return result;
}
function createRunner({cycle, intervalMs = 10000, report = () => {}, onError = () => {}}) {
  if (!Number.isInteger(intervalMs) || intervalMs < 1000) throw new Error('Interval must be at least 1000 ms');
  let running = null, timer = null, stopped = false;
  async function runOnce() {
    if (running || stopped) return {
      skipped: true
    };
    running = Promise.resolve().then(cycle);
    try {
      const result = await running;
      report(result);
      return result;
    } finally {
      running = null;
    }
  }
  async function tick() {
    try {
      await runOnce();
    } catch {
      onError();
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  }
  return {
    runOnce,
    start() {
      if (timer || running || stopped) return;
      timer = setTimeout(tick, 0);
    },
    async stop() {
      stopped = true;
      clearTimeout(timer);
      if (running) await running.catch(() => {});
    }
  };
}
module.exports = {
  runCycle,
  createRunner
};
