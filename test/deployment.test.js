const {test}=require('node:test');const assert=require('node:assert/strict');
const {mkdtempSync,rmSync,statSync,writeFileSync,readFileSync}=require('node:fs');
const {tmpdir}=require('node:os');const path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {AutomationStore}=require('../automation');
const {createApp}=require('../server');
const {inspectConfiguration,databaseReady}=require('../deployment-check');
const {backupDatabase,restoreDatabase}=require('../database-backup');

test('deployment checks report names only and reject incomplete active features',()=>{
 const env={NODE_ENV:'production',VETASTART_PUBLIC_ORIGIN:'https://app.example',
   VETASTART_DB_PATH:'/var/data/events.sqlite',VETASTART_PERSISTENT_DATA_DIR:'/var/data'};
 assert.equal(inspectConfiguration(env).ok,true);
 const pilot=inspectConfiguration({...env,META_APP_SECRET:'secret-never-report'},{profile:'pilot'});
 assert.equal(pilot.ok,false);assert.ok(pilot.checks.some(c=>c.name==='SMTP_HOST'&&c.status==='missing_or_invalid'));
 assert.ok(!JSON.stringify(pilot).includes('secret-never-report'));
 assert.equal(inspectConfiguration({...env,VETASTART_DB_PATH:'/var/database/events.sqlite'}).ok,false);
 assert.equal(inspectConfiguration({...env,VETASTART_SIGNUP_ENABLED:'true'}).ok,false);
 assert.equal(inspectConfiguration({...env,ROBOKASSA_ENABLED:'true',ROBOKASSA_TEST_MODE:'false'}).ok,false);
 assert.equal(inspectConfiguration(env,{nodeVersion:'22.0.0'}).ok,false);
 assert.equal(inspectConfiguration({...env,VETASTART_AUTH_DEV_MODE:'true'}).ok,false);
});
test('readiness probes transactional database writes without retaining probe data or disturbing a caller transaction',()=>{
 const store=new AutomationStore(':memory:');
 try{
  assert.equal(databaseReady(store),true);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='service_probe'").get().n,0);
  store.db.exec('BEGIN');assert.equal(databaseReady(store),false);
  // If the probe had rolled back a transaction it did not own, this would fail.
  store.db.exec('ROLLBACK');
 }finally{store.close();}
});
test('backup and restore preserve durable queue with private permissions and refuse overwrite',t=>{
 const dir=mkdtempSync(path.join(tmpdir(),'vetastart-backup-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const source=path.join(dir,'original.sqlite'),backup=path.join(dir,'backup.sqlite'),restored=path.join(dir,'restored.sqlite');
 const store=new AutomationStore(source);
 try{
  const event={entry:[{id:'123',messaging:[{timestamp:Date.now(),sender:{id:'456'},recipient:{id:'123'},message:{mid:'m',text:'гайд'}}]}]};
  store.receive(Buffer.from(JSON.stringify(event)),event);
  backupDatabase(source,backup);
  assert.equal(statSync(backup).mode&0o777,0o600);
  store.process([{id:'guide',accountId:'123',trigger:'message',keyword:'гайд',reply:'Ответ'}]);
  restoreDatabase(backup,restored);assert.equal(statSync(restored).mode&0o777,0o600);
  const copy=new DatabaseSync(restored,{readOnly:true});
  try{assert.equal(copy.prepare('SELECT status FROM events').get().status,'pending');
      assert.equal(copy.prepare('SELECT count(*) AS n FROM drafts').get().n,0);}finally{copy.close();}
  assert.throws(()=>backupDatabase(source,source));
  assert.throws(()=>restoreDatabase(backup,source));
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM drafts').get().n,1);
  const existing=path.join(dir,'user-file');writeFileSync(existing,'do not overwrite');
  assert.throws(()=>restoreDatabase(backup,existing));assert.equal(readFileSync(existing,'utf8'),'do not overwrite');
  const corrupt=path.join(dir,'corrupt.sqlite');writeFileSync(corrupt,'invalid database');
  assert.throws(()=>restoreDatabase(corrupt,path.join(dir,'invalid-copy.sqlite')));
 }finally{store.close();}
});
test('health endpoints distinguish live process from invalid configuration and hide diagnostic details',async t=>{
 const store=new AutomationStore(':memory:');
 const env={NODE_ENV:'production',META_APP_SECRET:'sensitive-test-only'};
 const app=createApp({store,env});const server=app.listen(0,'127.0.0.1');
 await new Promise(r=>server.once('listening',r));t.after(async()=>{await new Promise(r=>server.close(r));store.close();});
 const base=`http://127.0.0.1:${server.address().port}`;
 assert.equal((await fetch(base+'/health/live')).status,200);
 const failed=await fetch(base+'/health/ready');assert.equal(failed.status,503);
 assert.deepEqual(await failed.json(),{status:'unavailable'});
 Object.assign(env,{VETASTART_PUBLIC_ORIGIN:'https://app.example',VETASTART_DB_PATH:'/var/data/db.sqlite',VETASTART_PERSISTENT_DATA_DIR:'/var/data'});
 const ready=await fetch(base+'/health/ready');assert.equal(ready.status,200);
 assert.deepEqual(await ready.json(),{status:'ready',externalServicesVerified:false});
});
