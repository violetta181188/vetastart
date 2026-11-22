const {test}=require('node:test');const assert=require('node:assert/strict');
const {PostgresAutomationStore}=require('../postgres-automation');
const connectionString=process.env.VETASTART_PG_TEST_URL;
const rule={id:'guide',accountId:'123',trigger:'message',keyword:'гайд',reply:'Ссылка'};
const payload=mid=>({object:'instagram',entry:[{id:'123',messaging:[{timestamp:Date.now(),sender:{id:'456'},recipient:{id:'123'},message:{mid,text:'Хочу ГАЙД!'}}]}]});
const receive=(store,data)=>store.receive(Buffer.from(JSON.stringify(data)),data);

test('real PostgreSQL inbox and queue integration',{skip:!connectionString},async t=>{
 const store=new PostgresAutomationStore({connectionString});t.after(()=>store.close());
 // Integration URL must identify an isolated test database, never a live Render DB.
 assert.equal(new URL(connectionString).pathname,'/vetastart_test');
 await store.pool.query('CREATE TABLE IF NOT EXISTS public.compatibility_marker (id TEXT PRIMARY KEY)');
 await store.pool.query("INSERT INTO public.compatibility_marker VALUES ('existing-user-data') ON CONFLICT DO NOTHING");
 await t.test('schema migration is idempotent and preserves unrelated data',async()=>{
  await store.initialize();await store.pool.query(require('node:fs').readFileSync(require('node:path').join(__dirname,'..','postgres-automation-schema.sql'),'utf8'));
  assert.equal((await store.pool.query('SELECT id FROM public.compatibility_marker')).rows[0].id,'existing-user-data');
 });
 await t.test('duplicate deliveries and messages create one durable event',async()=>{
  const event=payload('m1');assert.equal((await receive(store,event)).duplicate,false);
  assert.equal((await receive(store,event)).duplicate,true);
  event.entry[0].time=999;await receive(store,event);
  assert.equal((await store.pool.query('SELECT count(*)::int AS n FROM vetastart_automation.events')).rows[0].n,1);
 });
 await t.test('parallel workers claim different events without duplicate drafts',async()=>{
  for(let n=2;n<=6;n++)await receive(store,payload('m'+n));
  const results=await Promise.all([store.process([rule],3),store.process([rule],3)]);
  assert.equal(results.reduce((sum,r)=>sum+r.drafts,0),6);
  assert.equal((await store.pool.query('SELECT count(*)::int AS n FROM vetastart_automation.drafts')).rows[0].n,6);
  assert.deepEqual(await store.process([rule]),{processed:0,drafts:0});
 });
 await t.test('failed draft write rolls back event processing and can be retried',async()=>{
  await receive(store,payload('retry'));
  await store.pool.query(`CREATE FUNCTION vetastart_automation.reject_test_draft() RETURNS trigger LANGUAGE plpgsql AS
   $$ BEGIN RAISE EXCEPTION 'test rejection'; END $$;
   CREATE TRIGGER test_reject BEFORE INSERT ON vetastart_automation.drafts FOR EACH ROW EXECUTE FUNCTION vetastart_automation.reject_test_draft();`);
  await assert.rejects(store.process([rule]));
  assert.equal((await store.pool.query("SELECT status FROM vetastart_automation.events WHERE source_id='retry'")).rows[0].status,'pending');
  await store.pool.query('DROP TRIGGER test_reject ON vetastart_automation.drafts; DROP FUNCTION vetastart_automation.reject_test_draft()');
  assert.equal((await store.process([rule])).drafts,1);
 });
 await t.test('closing and reopening connections preserves queue and timestamps',async()=>{
  const reopened=new PostgresAutomationStore({connectionString});
  try{await reopened.initialize();assert.equal((await reopened.pool.query('SELECT count(*)::int AS n FROM vetastart_automation.drafts')).rows[0].n,7);
   assert.ok((await reopened.pool.query('SELECT occurred_at FROM vetastart_automation.events LIMIT 1')).rows[0].occurred_at);
  }finally{await reopened.close();}
 });
});
