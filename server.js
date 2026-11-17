'use strict';
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const { plan, normalizeScenario, cleanName } = require('./domain');
const app = express();
app.disable('x-powered-by');
const pool = new Pool({connectionString: process.env.DATABASE_URL,
  max: 8, connectionTimeoutMillis: 5000,
  ssl: process.env.DATABASE_SSL === 'true' ? {rejectUnauthorized: true} : undefined });
const COOKIE = 'vetastart_session', WEEK = 7*24*60*60*1000;
const secure = process.env.NODE_ENV === 'production';
const errMsg = (res,code,message) => res.status(code).json({error:message});
function equalSecret(a,b) {
  if(typeof a!=='string'||typeof b!=='string')return false;
  const l=Buffer.from(a),r=Buffer.from(b);
  return l.length===r.length&&crypto.timingSafeEqual(l,r);
}
function digest(s){return crypto.createHash('sha256').update(s).digest('hex');}
function pwHash(password,salt=crypto.randomBytes(16).toString('hex')){
  return salt+':'+crypto.scryptSync(password,salt,64).toString('hex');
}
function pwVerify(password,encoded){
  if(typeof password!=='string'||typeof encoded!=='string')return false;
  const [salt,hash]=encoded.split(':');
  return !!(salt&&hash&&equalSecret(pwHash(password,salt),encoded));
}
function cookieToken(req){
  const found=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(COOKIE+'='));
  return found?found.substring(COOKIE.length+1):null;
}
function setCookie(res,token,age){res.cookie(COOKIE,token,{httpOnly:true,secure,sameSite:'strict',path:'/',maxAge:age});}
function publicUser(u){return {id:String(u.id),name:u.name,email:u.email};}
app.use((req,res,next)=>{
  res.set('X-Content-Type-Options','nosniff');
  res.set('Referrer-Policy','strict-origin-when-cross-origin');
  res.set('X-Frame-Options','DENY');
  res.set('Cache-Control',req.path.startsWith('/api/')?'no-store':'no-cache');
  next();
});

// Preserve the existing webhook endpoint and signature verification.
app.get('/webhooks/instagram',(req,res)=>{
  const token=process.env.INSTAGRAM_VERIFY_TOKEN;
  if(!token)return res.sendStatus(503);
  const mode=req.query['hub.mode'], supplied=req.query['hub.verify_token'],challenge=req.query['hub.challenge'];
  if(mode!=='subscribe'||typeof challenge!=='string'||!challenge||!equalSecret(supplied,token))return res.sendStatus(403);
  return res.status(200).type('text/plain').send(challenge);
});
app.post('/webhooks/instagram',express.raw({type:'application/json',limit:'1mb'}),(req,res)=>{
  const secret=process.env.META_APP_SECRET;
  if(!secret)return res.sendStatus(503);
  if(!Buffer.isBuffer(req.body))return res.sendStatus(415);
  const sig=req.get('x-hub-signature-256')||'';
  const expected='sha256='+crypto.createHmac('sha256',secret).update(req.body).digest('hex');
  if(!equalSecret(sig,expected))return res.sendStatus(403);
  let event;
  try{event=JSON.parse(req.body.toString('utf8'));}catch{return res.sendStatus(400);}
  if(!event||event.object!=='instagram'||!Array.isArray(event.entry))return res.sendStatus(400);
  // Webhook transport is available. DO NOT claim that sending messages is implemented.
  console.log('Instagram webhook verified',{entries:event.entry.length});
  return res.status(200).send('EVENT_RECEIVED');
});

app.use('/api',express.json({limit:'30kb'}));
function sameOrigin(req,res,next){
  if(!['POST','PATCH','PUT','DELETE'].includes(req.method))return next();
  const origin=req.get('origin');
  const referer=req.get('referer');
  let url;
  try{url=new URL(origin||referer);}catch{return errMsg(res,403,'Не удалось проверить источник запроса');}
  if(url.host!==req.get('host')||(secure&&url.protocol!=='https:'))return errMsg(res,403,'Неверный источник запроса');
  next();
}
app.use('/api',sameOrigin);
function needDb(req,res,next){if(!process.env.DATABASE_URL)return errMsg(res,503,'База данных пока не подключена');next();}
app.use('/api',needDb);
const hits=new Map();
function limitAuth(req,res,next){
  const ip=req.ip||'unknown',key=digest(ip),now=Date.now();
  for(const [k,v] of hits)if(now-v.started>15*60*1000)hits.delete(k);
  const a=hits.get(key)||{started:now,count:0};a.count++;hits.set(key,a);
  if(a.count>15)return errMsg(res,429,'Слишком много попыток. Попробуйте позже');
  next();
}
async function createSession(res,user,db=pool){
  const token=crypto.randomBytes(32).toString('hex');
  await db.query('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES ($1,$2,$3)',[digest(token),user.id,new Date(Date.now()+WEEK)]);
  setCookie(res,token,WEEK);
  return publicUser(user);
}
async function currentUser(req){
  const token=cookieToken(req);
  if(!token||!/^[a-f0-9]{64}$/.test(token))return null;
  const q=await pool.query(`SELECT u.id,u.name,u.email FROM sessions s
     JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now()`,[digest(token)]);
  return q.rows[0]||null;
}
async function auth(req,res,next){
  try{req.user=await currentUser(req);if(!req.user)return errMsg(res,401,'Войдите в личный кабинет');next();}
  catch(e){next(e);}
}
app.post('/api/auth/register',limitAuth,async(req,res,next)=>{
  let {name,email,password}=req.body||{};
  if(typeof name!=='string'||typeof email!=='string'||typeof password!=='string')return errMsg(res,400,'Заполните все поля');
  name=name.trim();email=email.trim().toLowerCase();
  if(!name||name.length>80||email.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||password.length<12||password.length>128)
    return errMsg(res,400,'Проверьте имя, email и пароль (12–128 символов)');
  let db;
  try{
    db=await pool.connect();await db.query('BEGIN');
    const row=(await db.query('INSERT INTO users(name,email,password_hash) VALUES($1,$2,$3) RETURNING id,name,email',
      [name,email,pwHash(password)])).rows[0];
    await db.query('INSERT INTO instagram_accounts(user_id,name) VALUES($1,$2)',[row.id,'Instagram 1']);
    const user=await createSession(res,row,db);
    await db.query('COMMIT');res.status(201).json({user});
  }catch(e){if(db)await db.query('ROLLBACK').catch(()=>{});if(e.code==='23505')return errMsg(res,409,'Этот email уже зарегистрирован');next(e);}
  finally{if(db)db.release();}
});
app.post('/api/auth/login',limitAuth,async(req,res,next)=>{
  const {email,password}=req.body||{};
  if(typeof email!=='string'||typeof password!=='string'||email.length>254)return errMsg(res,400,'Введите email и пароль');
  try{
    const r=await pool.query('SELECT * FROM users WHERE email=$1',[email.trim().toLowerCase()]);
    if(!r.rows[0]||!pwVerify(password,r.rows[0].password_hash))return errMsg(res,401,'Неверный email или пароль');
    res.json({user:await createSession(res,r.rows[0])});
  }catch(e){next(e);}
});
app.get('/api/auth/me',async(req,res,next)=>{
  try{const user=await currentUser(req);res.json({user:user?publicUser(user):null});}catch(e){next(e);}
});
app.post('/api/auth/logout',async(req,res,next)=>{
  try{const token=cookieToken(req);if(token&&/^[a-f0-9]{64}$/.test(token))await pool.query('DELETE FROM sessions WHERE token_hash=$1',[digest(token)]);
    setCookie(res,'',0);res.json({ok:true});}catch(e){next(e);}
});
function numericId(s){return typeof s==='string'&&/^[1-9]\d{0,17}$/.test(s)?s:null;}
app.get('/api/accounts',auth,async(req,res,next)=>{
  try{const q=await pool.query('SELECT id,name,connection_status,created_at FROM instagram_accounts WHERE user_id=$1 ORDER BY id',[req.user.id]);
    res.json({accounts:q.rows.map(a=>({...a,id:String(a.id),connected:false})),billing:plan(q.rows.length)});
  }catch(e){next(e);}
});
app.post('/api/accounts',auth,async(req,res,next)=>{
  const name=cleanName(req.body?.name,50);if(!name)return errMsg(res,400,'Введите название аккаунта (до 50 символов)');
  let db;try{
    db=await pool.connect();await db.query('BEGIN');
    await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[req.user.id]);
    const n=Number((await db.query('SELECT count(*) AS n FROM instagram_accounts WHERE user_id=$1',[req.user.id])).rows[0].n);
    if(n>=100){await db.query('ROLLBACK');return errMsg(res,409,'Максимум 100 черновиков аккаунтов');}
    const a=(await db.query('INSERT INTO instagram_accounts(user_id,name) VALUES($1,$2) RETURNING id,name,connection_status',[req.user.id,name])).rows[0];
    await db.query('COMMIT');res.status(201).json({account:{...a,id:String(a.id),connected:false},billing:plan(n+1)});
  }catch(e){if(db)await db.query('ROLLBACK').catch(()=>{});next(e);}finally{if(db)db.release();}
});
app.delete('/api/accounts/:id',auth,async(req,res,next)=>{
  const id=numericId(req.params.id);if(!id)return errMsg(res,400,'Некорректный ID аккаунта');
  let db;try{
    db=await pool.connect();await db.query('BEGIN');await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[req.user.id]);
    const count=Number((await db.query('SELECT count(*) AS n FROM instagram_accounts WHERE user_id=$1',[req.user.id])).rows[0].n);
    if(count<=1){await db.query('ROLLBACK');return errMsg(res,409,'Оставьте хотя бы один рабочий проект');}
    const q=await db.query('DELETE FROM instagram_accounts WHERE id=$1 AND user_id=$2 AND connection_status=$3 RETURNING id',
      [id,req.user.id,'not_connected']);
    if(!q.rowCount){await db.query('ROLLBACK');return errMsg(res,404,'Аккаунт не найден');}
    await db.query('COMMIT');res.json({ok:true,billing:plan(count-1)});
  }catch(e){if(db)await db.query('ROLLBACK').catch(()=>{});next(e);}finally{if(db)db.release();}
});
const scenarioSelect=`SELECT s.id,s.account_id,s.name,s.keyword,s.trigger_source,s.enabled,s.follow_gate,s.messages,s.choices,s.updated_at
 FROM scenarios s JOIN instagram_accounts a ON a.id=s.account_id WHERE a.user_id=$1`;
app.get('/api/accounts/:id/scenarios',auth,async(req,res,next)=>{
  const id=numericId(req.params.id);if(!id)return errMsg(res,400,'Некорректный ID');
  try{
    const q=await pool.query('SELECT id FROM instagram_accounts WHERE id=$1 AND user_id=$2',[id,req.user.id]);
    if(!q.rowCount)return errMsg(res,404,'Рабочий проект не найден');
    const r=await pool.query(scenarioSelect+' AND s.account_id=$2 ORDER BY s.id',[req.user.id,id]);
    res.json({scenarios:r.rows.map(s=>({...s,id:String(s.id),account_id:String(s.account_id)})),sending_enabled:false});
  }catch(e){next(e);}
});
async function withScenarioLock(userId,accountId,handler){
  const db=await pool.connect();try{
    await db.query('BEGIN');
    const a=await db.query('SELECT id FROM instagram_accounts WHERE id=$1 AND user_id=$2 FOR UPDATE',[accountId,userId]);
    if(!a.rowCount){await db.query('ROLLBACK');return {error:'Рабочий проект не найден',code:404};}
    const result=await handler(db);
    if(result.error){await db.query('ROLLBACK');return result;}
    await db.query('COMMIT');return result;
  }catch(e){await db.query('ROLLBACK').catch(()=>{});throw e;}finally{db.release();}
}
async function scenarioLimits(db,accountId,b,excludeId){
  const count=Number((await db.query('SELECT count(*) AS n FROM scenarios WHERE account_id=$1',[accountId])).rows[0].n);
  if(!excludeId&&count>=50)return {error:'Максимум 50 сохранённых сценариев',code:409};
  if(b.enabled){
    const active=Number((await db.query('SELECT count(*) AS n FROM scenarios WHERE account_id=$1 AND enabled=true AND ($2::bigint IS NULL OR id<>$2)',[accountId,excludeId||null])).rows[0].n);
    if(active>=10)return {error:'Можно включить не более 10 сценариев',code:409};
  }
  return null;
}
function scenarioError(res,e){if(e?.code==='23505')return errMsg(res,409,'Ключевое слово уже используется другим активным сценарием');return null;}
app.post('/api/accounts/:id/scenarios',auth,async(req,res,next)=>{
  const id=numericId(req.params.id),b=normalizeScenario(req.body||{});
  if(!id||!b)return errMsg(res,400,'Проверьте сценарий, сообщения, кнопки и ссылки');
  try{
    const result=await withScenarioLock(req.user.id,id,async db=>{
      const limit=await scenarioLimits(db,id,b,null);if(limit)return limit;
      const q=await db.query(`INSERT INTO scenarios(account_id,name,keyword,trigger_source,enabled,follow_gate,messages,choices)
         VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb) RETURNING id`,
        [id,b.name,b.keyword,b.source,b.enabled,b.follow_gate,JSON.stringify(b.messages),JSON.stringify(b.choices)]);
      return {id:String(q.rows[0].id)};
    });
    if(result.error)return errMsg(res,result.code,result.error);
    res.status(201).json({ok:true,id:result.id,sending_enabled:false});
  }catch(e){if(!scenarioError(res,e))next(e);}
});
app.patch('/api/scenarios/:id',auth,async(req,res,next)=>{
  const id=numericId(req.params.id),b=normalizeScenario(req.body||{});
  if(!id||!b)return errMsg(res,400,'Проверьте сценарий, сообщения, кнопки и ссылки');
  try{
    const s=await pool.query('SELECT s.account_id FROM scenarios s JOIN instagram_accounts a ON a.id=s.account_id WHERE s.id=$1 AND a.user_id=$2',[id,req.user.id]);
    if(!s.rowCount)return errMsg(res,404,'Сценарий не найден');
    const accountId=String(s.rows[0].account_id);
    const result=await withScenarioLock(req.user.id,accountId,async db=>{
      const limit=await scenarioLimits(db,accountId,b,id);if(limit)return limit;
      const q=await db.query(`UPDATE scenarios SET name=$1,keyword=$2,trigger_source=$3,enabled=$4,
        follow_gate=$5,messages=$6::jsonb,choices=$7::jsonb,updated_at=now() WHERE id=$8 AND account_id=$9 RETURNING id`,
        [b.name,b.keyword,b.source,b.enabled,b.follow_gate,JSON.stringify(b.messages),JSON.stringify(b.choices),id,accountId]);
      if(!q.rowCount)return {error:'Сценарий не найден',code:404};return {id:String(q.rows[0].id)};
    });
    if(result.error)return errMsg(res,result.code,result.error);
    res.json({ok:true,id:result.id,sending_enabled:false});
  }catch(e){if(!scenarioError(res,e))next(e);}
});
app.delete('/api/scenarios/:id',auth,async(req,res,next)=>{
  const id=numericId(req.params.id);if(!id)return errMsg(res,400,'Некорректный ID');
  try{
    const q=await pool.query(`DELETE FROM scenarios WHERE id=$1 AND account_id IN
      (SELECT id FROM instagram_accounts WHERE user_id=$2) RETURNING id`,[id,req.user.id]);
    if(!q.rowCount)return errMsg(res,404,'Сценарий не найден');res.json({ok:true});
  }catch(e){next(e);}
});
app.get('/api/billing/preview',auth,async(req,res,next)=>{
  try{const r=await pool.query('SELECT count(*) AS n FROM instagram_accounts WHERE user_id=$1',[req.user.id]);
    res.json(plan(Number(r.rows[0].n)));}catch(e){next(e);}
});

app.patch('/api/account/profile',auth,async(req,res,next)=>{
  const name=cleanName(req.body?.name,80);
  if(!name)return errMsg(res,400,'Укажите имя длиной до 80 символов');
  try{
    const q=await pool.query('UPDATE users SET name=$1 WHERE id=$2 RETURNING id,name,email',[name,req.user.id]);
    if(!q.rowCount)return errMsg(res,404,'Пользователь не найден');
    res.json({user:publicUser(q.rows[0])});
  }catch(e){next(e);}
});
app.post('/api/account/change-password',auth,limitAuth,async(req,res,next)=>{
  const {currentPassword,newPassword}=req.body||{};
  if(typeof currentPassword!=='string'||typeof newPassword!=='string'||newPassword.length<12||newPassword.length>128)
    return errMsg(res,400,'Новый пароль должен содержать от 12 до 128 символов');
  try{
    const q=await pool.query('SELECT password_hash FROM users WHERE id=$1',[req.user.id]);
    if(!q.rowCount||!pwVerify(currentPassword,q.rows[0].password_hash))
      return errMsg(res,403,'Текущий пароль неверный');
    const token=cookieToken(req);
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      await client.query('UPDATE users SET password_hash=$1 WHERE id=$2',[pwHash(newPassword),req.user.id]);
      await client.query('DELETE FROM sessions WHERE user_id=$1 AND token_hash<>$2',[req.user.id,digest(token)]);
      await client.query('COMMIT');
    }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{client.release();}
    res.json({ok:true,other_sessions_revoked:true});
  }catch(e){next(e);}
});
app.get('/api/account/export',auth,async(req,res,next)=>{
  try{
    const projects=await pool.query('SELECT id,name,connection_status,created_at FROM instagram_accounts WHERE user_id=$1 ORDER BY id',[req.user.id]);
    const flows=await pool.query(scenarioSelect+' ORDER BY s.id',[req.user.id]);
    const data={version:1,exported_at:new Date().toISOString(),profile:publicUser(req.user),
      accounts:projects.rows.map(a=>({...a,id:String(a.id)})),
      scenarios:flows.rows.map(s=>({...s,id:String(s.id),account_id:String(s.account_id)}))};
    res.set('Content-Disposition','attachment; filename="vetastart-export.json"');
    res.type('application/json').send(JSON.stringify(data,null,2));
  }catch(e){next(e);}
});

app.get('/healthz',(_req,res)=>res.json({status:'ok',service:'vetastart'}));
app.get('/dashboard.js',(_req,res)=>res.type('application/javascript').sendFile(path.join(__dirname,'dashboard.js')));
app.get('/',(_req,res)=>res.sendFile(path.join(__dirname,'index.html')));
app.get('*',(_req,res)=>res.sendFile(path.join(__dirname,'index.html')));
app.use((error,req,res,_next)=>{
  if(error?.type==='entity.too.large')return errMsg(res,413,'Слишком большой запрос');
  if(error instanceof SyntaxError&&error.status===400)return errMsg(res,400,'Неверный JSON');
  console.error('VetaStart API error',{route:req.path,code:error?.code||'unknown'});
  return errMsg(res,503,'Сервис временно недоступен');
});
const port=process.env.PORT||10000;
if(require.main===module)app.listen(port,'0.0.0.0',()=>console.log(`VetaStart started on ${port}`));
module.exports={app,plan,normalizeScenario};
