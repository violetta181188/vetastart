const path = require('node:path');
const {readFileSync} = require('node:fs');
const {AutomationStore, validateRules} = require('./automation');
const {customerRules} = require('./customers');
const {operatorRules} = require('../operator-rules');
async function processPending(store, {env = process.env, maxBatches = 10} = {}) {
  const fileRules = env.VETASTART_SCENARIOS_FILE ? validateRules(JSON.parse(readFileSync(env.VETASTART_SCENARIOS_FILE, 'utf8'))) : [];
  const owned = new Set(await store.db.prepare("SELECT name FROM sqlite_master WHERE name='customer_accounts'").get() ? (await store.db.prepare('SELECT account_id FROM customer_accounts').all()).map(a => a.account_id) : []);
  const rules = validateRules([...await operatorRules(store.db),...fileRules.filter(r => !owned.has(r.accountId)), ...await customerRules(store.db)]);
  if (!rules.length) return {
    processed: 0,
    drafts: 0
  };
  let total = {
    processed: 0,
    drafts: 0
  };
  for (let batch = 0; batch < maxBatches; batch++) {
    const result = await store.process(rules);
    total.processed += result.processed;
    total.drafts += result.drafts;
    if (result.processed < 100) break;
  }
  return total;
}
module.exports = {
  processPending
};
