const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const {Pool}=require('pg');
const {extractEvents,matches,validateRules}=require('./automation');

// Async PostgreSQL counterpart of the tested inbox/draft pipeline. Explicitly
// opt-in: not selected by DATABASE_URL alone while customer/auth migration is pending.
class PostgresAutomationStore {
 constructor({connectionString,ssl,max=4}){
  if(!connectionString)throw new Error('PostgreSQL connection is required');
  this.pool=new Pool({connectionString,ssl,max,connectionTimeoutMillis:5000,statement_timeout:10000});
  this.initializing=null;
  // Background socket errors must not crash the process or disclose credentials.
  this.pool.on('error',()=>{});
 }
 async initialize(){
  if(!this.initializing)this.initializing=(async()=>{
   const db=await this.pool.connect();
   try{
    await db.query('BEGIN');await db.query('SELECT pg_advisory_xact_lock(21450,1)');
    await db.query(fs.readFileSync(path.join(__dirname,'postgres-automation-schema.sql'),'utf8'));
    await db.query('COMMIT');
   }catch(error){await db.query('ROLLBACK').catch(()=>{});throw error;}finally{db.release();}
  })().catch(error=>{this.initializing=null;throw error;});
  await this.initializing;
 }
 async transaction(action){
  await this.initialize();const db=await this.pool.connect();
  try{await db.query('BEGIN');const result=await action(db);await db.query('COMMIT');return result;}
  catch(error){await db.query('ROLLBACK').catch(()=>{});throw error;}
  finally{db.release();}
 }
 async receive(raw,payload){
  const id=crypto.createHash('sha256').update(raw).digest('hex');
  return this.transaction(async db=>{
   const inserted=await db.query(`INSERT INTO vetastart_automation.deliveries(id,raw_body)
    VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING id`,[id,raw.toString('utf8')]);
   if(!inserted.rowCount)return {duplicate:true};
   for(const event of extractEvents(payload))await db.query(`INSERT INTO vetastart_automation.events
    (id,delivery_id,account_id,type,source_id,sender_id,text,occurred_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(account_id,type,source_id) DO NOTHING`,
    [crypto.randomUUID(),id,event.accountId,event.type,event.sourceId,event.senderId,event.text,event.occurredAt??null]);
   return {duplicate:false};
  });
 }
 async process(rules,limit=100){
  validateRules(rules);
  if(!Number.isInteger(limit)||limit<1||limit>1000)throw new Error('Invalid batch size');
  return this.transaction(async db=>{
   const {rows}=await db.query(`SELECT * FROM vetastart_automation.events WHERE status='pending'
    ORDER BY created_at,id LIMIT $1 FOR UPDATE SKIP LOCKED`,[limit]);
   let drafts=0;
   for(const event of rows){
    const rule=rules.find(r=>r.enabled!==false&&r.accountId===event.account_id&&r.trigger===event.type&&matches(event.text,r.keyword));
    if(rule){
     await db.query(`INSERT INTO vetastart_automation.drafts
      (id,event_id,scenario_id,account_id,recipient_id,text) VALUES($1,$2,$3,$4,$5,$6)`,
      [crypto.randomUUID(),event.id,rule.id,event.account_id,event.sender_id,rule.reply]);drafts++;
    }
    await db.query('UPDATE vetastart_automation.events SET status=$1 WHERE id=$2',[rule?'drafted':'unmatched',event.id]);
   }
   return {processed:rows.length,drafts};
  });
 }
 async close(){await this.pool.end();}
}
module.exports={PostgresAutomationStore};
