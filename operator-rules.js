const crypto = require('node:crypto');
const express = require('express');
const path = require('node:path');
const {adminOnly} = require('./admin-status');
const {matches} = require('./postgres-app/automation');

async function initializeOperatorRules(db) {
  await db.exec(`CREATE TABLE IF NOT EXISTS operator_rules (
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL, keyword TEXT NOT NULL,
    reply TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0
  )`);
}
async function operatorRules(db) {
  await initializeOperatorRules(db);
  const rows = await db.prepare(`SELECT r.* FROM operator_rules r
    JOIN instagram_connections c ON c.account_id=r.account_id AND c.connection_status='active'
    WHERE NOT EXISTS (SELECT 1 FROM customer_accounts a WHERE a.account_id=r.account_id)
    ORDER BY r.id`).all();
  return rows.map(r => ({id:r.id,accountId:r.account_id,trigger:'message',keyword:r.keyword,
    reply:r.reply,enabled:!!r.enabled}));
}
function installOperator(app, {getStore, env}) {
  app.get('/operator', (_req,res) => res.set('Cache-Control','no-store').sendFile(path.join(__dirname,'operator.html')));
  const router = express.Router();
  router.use(adminOnly(env), express.json({limit:'8kb'}));
  router.use(async (req,res,next) => {
    try {req.db=getStore().db;await initializeOperatorRules(req.db);next();}
    catch {res.sendStatus(503);}
  });
  const action = fn => async(req,res) => {try{await fn(req,res);}catch{res.sendStatus(503);}};
  router.get('/rules', action(async(req,res) => res.json(await operatorRules(req.db))));
  const save = action(async(req,res) => {
    const {accountId,keyword,reply,enabled} = req.body || {};
    if (!/^\d+$/.test(accountId || '') || typeof keyword !== 'string' || !keyword.trim() || keyword.length>100 ||
        typeof reply !== 'string' || !reply.trim() || reply.length>1000 || typeof enabled !== 'boolean') return res.sendStatus(400);
    await req.db.transaction(async() => {
      const account = await req.db.prepare("SELECT 1 FROM instagram_connections WHERE account_id=? AND connection_status='active'").get(accountId);
      const owner = await req.db.prepare('SELECT 1 FROM customer_accounts WHERE account_id=?').get(accountId);
      if (!account || owner) return res.status(409).json({error:'account_unavailable_or_customer_owned'});
      const id = req.params.id || 'operator-'+crypto.randomUUID();
      if(req.params.id){
        const existing = await req.db.prepare('SELECT account_id FROM operator_rules WHERE id=?').get(id);
        if (!existing || existing.account_id !== accountId) return res.sendStatus(404);
        await req.db.prepare('UPDATE operator_rules SET keyword=?,reply=?,enabled=? WHERE id=?').run(keyword.trim(),reply.trim(),Number(enabled),id);
      } else {
        const count = await req.db.prepare('SELECT count(*) AS n FROM operator_rules WHERE account_id=?').get(accountId);
        if(Number(count.n)>=20)return res.sendStatus(409);
        await req.db.prepare('INSERT INTO operator_rules (id,account_id,keyword,reply,enabled) VALUES (?,?,?,?,?)')
          .run(id,accountId,keyword.trim(),reply.trim(),Number(enabled));
      }
      res.status(req.params.id ? 200 : 201).json({id});
    });
  });
  router.post('/rules',save);
  router.put('/rules/:id',save);
  router.delete('/rules/:id',action(async(req,res)=>{
    const result=await req.db.prepare('DELETE FROM operator_rules WHERE id=?').run(req.params.id);
    res.sendStatus(result.changes ? 204 : 404);
  }));
  router.post('/preview',action(async(req,res)=>{
    const {accountId,text}=req.body || {};
    if(typeof text!=='string'||text.length>2000||!/^\d+$/.test(accountId||''))return res.sendStatus(400);
    const rules=await operatorRules(req.db);
    const rule=rules.find(rule=>rule.enabled&&rule.accountId===accountId&&matches(text,rule.keyword));
    res.json({matched:!!rule,...(rule?{ruleId:rule.id,reply:rule.reply}:{}),sent:false});
  }));
  app.use('/api/admin/operator',router);
}
module.exports={initializeOperatorRules,operatorRules,installOperator};
