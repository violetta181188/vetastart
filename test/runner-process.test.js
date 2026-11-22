const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createInterface } = require('node:readline');
const { mkdtempSync,rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { AutomationStore } = require('../automation');
const { initializeCustomers } = require('../customers');

test('web process runs a draft-only background cycle and shuts down cleanly with persisted work', { timeout:10000 }, async t=>{
 const dir=mkdtempSync(path.join(tmpdir(),'vetastart-web-runner-'));
 const file=path.join(dir,'db.sqlite');
 const store=new AutomationStore(file);initializeCustomers(store.db);
 store.db.prepare('INSERT INTO customer_accounts VALUES (?,?)').run('123','tenant');
 store.db.prepare('INSERT INTO customer_rules VALUES (?,?,?,?,?,1)').run('rule','tenant','123','гайд','Ответ');
 const payload={entry:[{id:'123',messaging:[{timestamp:Date.now(),sender:{id:'456'},recipient:{id:'123'},message:{mid:'m',text:'гайд'}}]}]};
 store.receive(Buffer.from(JSON.stringify(payload)),payload);store.close();
 const child=spawn(process.execPath,[path.join(__dirname,'..','server.js')],{env:{...process.env,
   PORT:'0',VETASTART_DB_PATH:file,VETASTART_AUTOMATION_ENABLED:'true',VETASTART_SEND_ENABLED:'false',
   VETASTART_AUTOMATION_INTERVAL_MS:'1000',VETASTART_SCENARIOS_FILE:''},stdio:['ignore','pipe','pipe']});
 const closed=once(child,'close');
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await closed;}rmSync(dir,{recursive:true,force:true});});
 const lines=createInterface({input:child.stdout});
 const result=await new Promise((resolve,reject)=>{
  lines.on('line',line=>{try{const data=JSON.parse(line);if(typeof data.processed==='number')resolve(data);}catch{}});
  child.once('error',reject);child.once('exit',()=>reject(new Error('Web process exited before its first cycle')));
 });
 assert.equal(result.processed,1);assert.equal(result.drafts,1);assert.equal(result.sent,0);
 child.kill('SIGTERM');const [code,signal]=await closed;assert.equal(code,0);assert.equal(signal,null);
 const restored=new AutomationStore(file);
 try{assert.equal(restored.db.prepare("SELECT count(*) AS n FROM drafts WHERE status='draft'").get().n,1);}finally{restored.close();}
});
