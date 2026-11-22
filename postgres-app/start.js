const {PostgresDatabase} = require('../postgres-database');
const {AutomationStore} = require('./automation');
const {initializeCustomers} = require('./customers');
const {initialize} = require('./instagram-auth');
const {initializeSubscriptions} = require('./subscriptions');
const {initializeBilling} = require('./robokassa');
const {createApp} = require('./server');
const {runCycle, createRunner} = require('./automation-runner');
const {inspectConfiguration}=require('../deployment-check');
const {importLegacyUsers}=require('./legacy');
const {initializeOperatorRules}=require('../operator-rules');
async function prepareStore(env) {
  const db = new PostgresDatabase({
    connectionString: env.DATABASE_URL,
    schema: env.VETASTART_PG_SCHEMA || 'vetastart_pilot',
    ssl: env.DATABASE_SSL === 'true' ? {
      rejectUnauthorized: true
    } : undefined
  });
  const store = new AutomationStore(db);
  try {
    await db.initialize();
    await db.transaction(async () => {
      await store.initialize();
      await initializeCustomers(db);
      await initialize(db);
      await initializeSubscriptions(db);
      await initializeBilling(db);
      await initializeOperatorRules(db);
      await importLegacyUsers(db);
    });
    return store;
  } catch (error) {
    await db.close();
    throw error;
  }
}
async function main() {
  const env = process.env;
  if(!inspectConfiguration(env,{profile:env.VETASTART_READINESS_PROFILE||'runtime'}).ok)throw new Error('Incomplete configuration');
  const store = await prepareStore(env);
  const app = createApp({
    store,
    env
  });
  let runner;
  try{runner = env.VETASTART_AUTOMATION_ENABLED === 'true' ? createRunner({
    intervalMs: Number(env.VETASTART_AUTOMATION_INTERVAL_MS || 10000),
    cycle: () => runCycle(store, {
      env
    }),
    report: result => console.log(JSON.stringify(result)),
    onError: () => console.error('PostgreSQL automation cycle failed')
  }) : null;}catch(error){await store.close();throw error;}
  const server = app.listen(env.PORT || 10000, '0.0.0.0', () => {
    console.log('VetaStart PostgreSQL service started on port '+server.address().port);
    runner?.start();
  });
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await runner?.stop();
    await new Promise(r => server.close(r));
    await store.close();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  server.once('error', async () => {
    await runner?.stop();
    await store.close();
    process.exitCode = 1;
  });
}
module.exports = {
  prepareStore,
  main
};
