const path = require('node:path');
const { readFileSync } = require('node:fs');
const { AutomationStore, validateRules } = require('./automation');
const { customerRules } = require('./customers');

function processPending(store, { env = process.env, maxBatches = 10 } = {}) {
    const fileRules = env.VETASTART_SCENARIOS_FILE
      ? validateRules(JSON.parse(readFileSync(env.VETASTART_SCENARIOS_FILE, 'utf8'))) : [];
    // A shared admin file may never override a customer's owned account.
    const owned = new Set(store.db.prepare("SELECT name FROM sqlite_master WHERE name='customer_accounts'").get()
      ? store.db.prepare('SELECT account_id FROM customer_accounts').all().map(a => a.account_id) : []);
    const rules = validateRules([...fileRules.filter(r => !owned.has(r.accountId)), ...customerRules(store.db)]);
    if (!rules.length) return { processed: 0, drafts: 0 };
    let total = { processed: 0, drafts: 0 };
    for (let batch = 0; batch < maxBatches; batch++) {
      const result = store.process(rules);
      total.processed += result.processed;
      total.drafts += result.drafts;
      if (result.processed < 100) break;
    }
    return total;
}

function main() {
  const store = new AutomationStore(process.env.VETASTART_DB_PATH || path.join(__dirname, 'data', 'automation.sqlite'));
  try {
    console.log(JSON.stringify(processPending(store)));
  } finally { store.close(); }
}
module.exports = { processPending };

if (require.main === module) {
  try { main(); } catch { console.error('Scenario processing failed: check configuration and database access'); process.exitCode = 1; }
}
