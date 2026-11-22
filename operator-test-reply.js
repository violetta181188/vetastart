const crypto=require('node:crypto');
const express=require('express');
const {adminOnly}=require('./admin-status');
const {readTestInbox}=require('./admin-inbox-probe');
const {unseal}=require('./instagram-auth');
const {sendDrafts}=require('./postgres-app/sender');
async function initializeTestReplies(db){
  await db.exec(`CREATE TABLE IF NOT EXISTS operator_test_replies (
    draft_id TEXT PRIMARY KEY,account_id TEXT NOT NULL,sender_username TEXT NOT NULL
  )`);
}
function installTestReplies(app,{getStore,env,fetchImpl=fetch,now=Date.now}){
  const router=express.Router({mergeParams:true});router.use(adminOnly(env),express.json({limit:'1kb'}));
  router.use(async(req,res,next)=>{
    try{
      if(!/^\d+$/.test(req.params.id||''))return res.sendStatus(400);
      req.store=getStore();req.db=req.store.db;
      const account=await req.db.prepare(`SELECT c.token_cipher,c.token_mode FROM instagram_connections c
        WHERE c.account_id=? AND c.connection_status='active' AND NOT EXISTS
        (SELECT 1 FROM customer_accounts a WHERE a.account_id=c.account_id)`).get(req.params.id);
      if(!account||account.token_mode!=='unified')return res.sendStatus(409);
      req.connection=account;await initializeTestReplies(req.db);next();
    }catch{res.sendStatus(503);}
  });
  router.post('/prepare',async(req,res)=>{
    try{
      if(env.VETASTART_AUTOMATION_ENABLED==='true'||env.VETASTART_SEND_ENABLED==='true')
        return res.status(409).json({error:'pause_background_sending_before_test'});
      const id=req.params.id;
      const read=await readTestInbox({id,token:unseal(req.connection.token_cipher,env),
        version:env.META_GRAPH_API_VERSION,fetchImpl,now});
      const candidate=read.candidates[0];
      if(!candidate)return res.status(409).json({error:'no_recent_test_from_expected_sender'});
      const rule=await req.db.prepare(`SELECT id,reply FROM operator_rules WHERE account_id=?
        AND keyword='VETASTART ТЕСТ' AND enabled=1 ORDER BY id LIMIT 1`).get(id);
      if(!rule)return res.status(409).json({error:'enable_owner_test_rule_first'});
      const payload={object:'instagram',ingestion_source:'owner_api_test',entry:[{id,messaging:[{
        timestamp:candidate.occurredAt,sender:{id:candidate.senderId},recipient:{id},
        message:{mid:candidate.id,text:candidate.text}}]}]};
      await req.store.receive(Buffer.from(JSON.stringify(payload)),payload);
      await req.db.transaction(async()=>{
        // Recheck ownership inside the shared domain lock, before queue changes.
        if(await req.db.prepare('SELECT 1 FROM customer_accounts WHERE account_id=?').get(id))throw new Error('Ownership changed');
        const event=await req.db.prepare("SELECT id FROM events WHERE account_id=? AND type='message' AND source_id=?").get(id,candidate.id);
        if(!event)throw new Error('Test event unavailable');
        await req.db.prepare(`INSERT INTO drafts (id,event_id,scenario_id,account_id,recipient_id,text,created_at)
          VALUES (?,?,?,?,?,?,?) ON CONFLICT(event_id) DO NOTHING`)
          .run(crypto.randomUUID(),event.id,rule.id,id,candidate.senderId,rule.reply,new Date(now()).toISOString());
        const draft=await req.db.prepare('SELECT id,status,text,scenario_id FROM drafts WHERE event_id=?').get(event.id);
        if(draft.scenario_id!==rule.id||draft.text!==rule.reply)throw new Error('Existing draft differs');
        await req.db.prepare(`INSERT INTO operator_test_replies (draft_id,account_id,sender_username)
          VALUES (?,?,?) ON CONFLICT(draft_id) DO NOTHING`).run(draft.id,id,candidate.senderUsername);
        await req.db.prepare("UPDATE events SET status='drafted' WHERE id=? AND status='pending'").run(event.id);
        res.json({draftId:draft.id,to:'@'+candidate.senderUsername,reply:draft.text,status:draft.status,
          expiresAt:candidate.occurredAt+86400000,sent:false});
      });
    }catch(error){res.status(error.diagnostic?502:503).json(error.diagnostic||{error:'test_preparation_failed'});}
  });
  router.post('/:draftId/send',async(req,res)=>{
    try{
      if(req.body?.confirm!=='send-one-test-reply')return res.sendStatus(400);
      const draft=await req.db.prepare(`SELECT d.id,d.status,d.text,r.reply FROM drafts d
        JOIN operator_test_replies t ON t.draft_id=d.id AND t.account_id=d.account_id
        JOIN operator_rules r ON r.id=d.scenario_id AND r.account_id=d.account_id AND r.enabled=1
        WHERE d.id=? AND d.account_id=? AND t.sender_username='violettaproekti'`).get(req.params.draftId,req.params.id);
      if(!draft||draft.text!==draft.reply)return res.sendStatus(409);
      if(draft.status!=='draft')return res.status(draft.status==='sending'?409:200).json({status:draft.status,alreadyAttempted:true,sent:0});
      const result=await sendDrafts(req.store,{env:{...env,INSTAGRAM_ACCESS_TOKEN:undefined,
        INSTAGRAM_ACCOUNT_ID:req.params.id,INSTAGRAM_LOGIN_MODE:'unified',VETASTART_SEND_ENABLED:'true'},
        fetchImpl,now,limit:1,draftId:draft.id});
      const after=await req.db.prepare('SELECT status FROM drafts WHERE id=?').get(draft.id);
      res.json({status:after.status,sent:result.sent,unknown:result.unknown,failed:result.failed,blocked:result.blocked});
    }catch{res.status(503).json({error:'test_send_unavailable'});}
  });
  app.use('/api/admin/instagram/accounts/:id/test-reply',router);
}
module.exports={initializeTestReplies,installTestReplies};
