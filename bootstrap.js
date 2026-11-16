'use strict';
const { spawn } = require('node:child_process');
function runScript(file) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file], { stdio: 'inherit', env: process.env });
    child.once('error', reject);
    child.once('exit', code => resolve(code ?? 1));
  });
}
async function main() {
  if (process.env.DATABASE_URL) {
    const status = await runScript('migrate.js');
    if (status !== 0) process.exit(status);
  } else console.warn('Staging: DATABASE_URL missing; account APIs disabled.');
  const server = spawn(process.execPath, ['server.js'], { stdio: 'inherit', env: process.env });
  process.once('SIGTERM', () => server.kill('SIGTERM'));
  process.once('SIGINT', () => server.kill('SIGINT'));
  server.once('error', error => { console.error(error.message); process.exit(1); });
  server.once('exit', code => process.exit(code ?? 1));
}
main().catch(error => { console.error('Staging startup failed:', error.message); process.exit(1); });
