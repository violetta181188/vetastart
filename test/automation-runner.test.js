const { test } = require('node:test');
const assert = require('node:assert/strict');
const { AutomationStore } = require('../automation');
const { initialize, seal } = require('../instagram-auth');
const { initializeCustomers } = require('../customers');
const { runCycle, createRunner } = require('../automation-runner');
const { processPending } = require('../worker');
const { startTrial } = require('../subscriptions');
const env = { VETASTART_AUTOMATION_ENABLED:'true', VETASTART_SEND_ENABLED:'true',
  META_GRAPH_API_VERSION:'v27.0', VETASTART_TOKEN_KEY:Buffer.alloc(32,3).toString('base64') };
function setup(t, count = 2) {
 const store=new AutomationStore(':memory:'); t.after(()=>store.close());
 initialize(store.db);initializeCustomers(store.db);
 for(let n=1;n<=count;n++) {
  const account=String(100+n), owner='customer-'+n;
  startTrial(store.db,owner);
  store.db.prepare('INSERT INTO customer_accounts VALUES (?,?)').run(account,owner);
  store.db.prepare('INSERT INTO customer_rules VALUES (?,?,?,?,?,1)').run('rule-'+n,owner,account,'гайд','Ответ '+n);
  store.db.prepare(`INSERT INTO instagram_connections (account_id,token_cipher,expires_at,token_mode,config_id)
    VALUES (?,?,0,'unified','12')`).run(account,seal('token-'+n,env));
  const payload={entry:[{id:account,messaging:[{timestamp:Date.now(),sender:{id:String(200+n)},
    recipient:{id:account},message:{mid:'m'+n,text:'гайд'}}]}]};
  store.receive(Buffer.from(JSON.stringify(payload)),payload);
 }
 return store;
}
test('cycle processes two customers with their own tokens and replies; repeat pass sends nothing twice',async t=>{
 const store=setup(t);const calls=[];
 const fetchImpl=async(url,init)=>{
  const account=new URL(url).pathname.split('/')[2];const n=Number(account)-100;
  assert.equal(init.headers.Authorization,'Bearer token-'+n);
  assert.deepEqual(JSON.parse(init.body),{recipient:{id:String(200+n)},message:{text:'Ответ '+n}});
  calls.push(account);return Response.json({message_id:'sent-'+n});
 };
 const result=await runCycle(store,{env,fetchImpl});
 assert.equal(result.sent,2);assert.equal(result.drafts,2);assert.equal(result.accounts,2);
 assert.equal((await runCycle(store,{env,fetchImpl})).sent,0);assert.equal(calls.length,2);
});
test('one expired connection does not stop other customers',async t=>{
 const store=setup(t);
 store.db.prepare("UPDATE instagram_connections SET expires_at=1 WHERE account_id='101'").run();
 const result=await runCycle(store,{env,fetchImpl:async url=>{
  assert.ok(url.includes('/102/'));return Response.json({message_id:'ok'});
 }});
 assert.equal(result.sent,1);assert.equal(result.accountErrors,1);
 assert.equal(store.db.prepare("SELECT status FROM drafts WHERE account_id='101'").get().status,'draft');
});
test('global automation switch is inert; draft-only mode never calls external API',async t=>{
 const store=setup(t);
 assert.equal((await runCycle(store,{env:{...env,VETASTART_AUTOMATION_ENABLED:'false'},fetchImpl:()=>assert.fail()})).processed,0);
 assert.equal(store.db.prepare("SELECT count(*) AS n FROM events WHERE status='pending'").get().n,2);
 const result=await runCycle(store,{env:{...env,VETASTART_SEND_ENABLED:'false'},fetchImpl:()=>assert.fail()});
 assert.equal(result.drafts,2);assert.equal(result.sent,0);
});
test('deleting a rule before sending blocks the queued reply',async t=>{
 const store=setup(t,1);processPending(store,{env});
 store.db.exec('DELETE FROM customer_rules');
 const result=await runCycle(store,{env,fetchImpl:()=>assert.fail('deleted rule must not send')});
 assert.equal(result.blocked,1);
});
test('account rotation avoids starving later customer accounts',async t=>{
 const store=setup(t,26);const sent=[];
 const fetchImpl=async url=>{sent.push(new URL(url).pathname.split('/')[2]);return Response.json({message_id:'ok'});};
 assert.equal((await runCycle(store,{env,fetchImpl,now:()=>Date.now()+1000})).accounts,25);
 assert.equal((await runCycle(store,{env,fetchImpl,now:()=>Date.now()+2000})).sent,1);
 assert.equal(new Set(sent).size,26);
});
test('runner prevents overlapping cycles and waits for active work during shutdown',async()=>{
 let release,calls=0;
 const runner=createRunner({cycle:()=>{calls++;return new Promise(resolve=>{release=resolve;});}});
 const first=runner.runOnce();await Promise.resolve();
 assert.deepEqual(await runner.runOnce(),{skipped:true});
 let stopped=false;const stopping=runner.stop().then(()=>{stopped=true;});await Promise.resolve();
 assert.equal(stopped,false);release({sent:1});await first;await stopping;
 assert.equal(calls,1);assert.deepEqual(await runner.runOnce(),{skipped:true});
});
