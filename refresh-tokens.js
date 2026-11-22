const path = require('node:path');
const { AutomationStore } = require('./automation');
const { refreshConnections } = require('./instagram-auth');

async function main() {
  const store = new AutomationStore(process.env.VETASTART_DB_PATH || path.join(__dirname, 'data', 'automation.sqlite'));
  try {
    const result = await refreshConnections(store);
    console.log(JSON.stringify(result));
    if (result.retry || result.reauthorizationRequired) process.exitCode = 1;
  } finally { store.close(); }
}
if (require.main === module) main().catch(() => {
  console.error('Instagram token maintenance failed: check configuration and connection status');
  process.exitCode = 1;
});
