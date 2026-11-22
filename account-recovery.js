const crypto=require('node:crypto');
const {promisify}=require('node:util');
const scrypt=promisify(crypto.scrypt);
const {startTrial}=require('./subscriptions');
const {createMailer}=require('./mailer');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const generic={ok:true,message:'Если аккаунт подходит для этого действия, письмо будет отправлено. Проверьте почту и папку «Спам».'};

function initializeRecovery(db){
 db.exec(`CREATE TABLE IF NOT EXISTS customer_action_tokens (
   token_hash TEXT PRIMARY KEY,customer_id TEXT NOT NULL,purpose TEXT NOT NULL,expires_at INTEGER NOT NULL
 );
 CREATE TABLE IF NOT EXISTS customer_mail_limits (
   key TEXT PRIMARY KEY,attempts INTEGER NOT NULL,expires_at INTEGER NOT NULL
 );`);
}

function developmentAuth(env){
 try{const origin=new URL(env.VETASTART_PUBLIC_ORIGIN);return env.VETASTART_AUTH_DEV_MODE==='true'&&
   origin.protocol==='http:'&&['localhost','127.0.0.1'].includes(origin.hostname);}catch{return false;}
}

function recoveryService({env,now=Date.now,sendMail}){
 let mail=sendMail;
 const getMail=()=>mail||=createMailer(env);
 async function issue(db,user,purpose,ip){
  initializeRecovery(db);
  const emailKey=hash(user.email+':'+purpose),ipKey=hash('ip:'+ip);
  db.prepare('DELETE FROM customer_mail_limits WHERE expires_at<=?').run(now());
  for(const [key,max] of [[emailKey,3],[ipKey,20]]){
   db.prepare(`INSERT INTO customer_mail_limits VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET attempts=attempts+1`)
    .run(key,now()+3600000);
   if(db.prepare('SELECT attempts FROM customer_mail_limits WHERE key=?').get(key).attempts>max)return;
  }
  const origin=new URL(env.VETASTART_PUBLIC_ORIGIN);
  if(origin.protocol!=='https:'&&!developmentAuth({...env,VETASTART_AUTH_DEV_MODE:'true'}))throw new Error('HTTPS required');
  const token=crypto.randomBytes(32).toString('hex');
  db.prepare('DELETE FROM customer_action_tokens WHERE expires_at<=?').run(now());
  db.prepare('INSERT INTO customer_action_tokens VALUES (?,?,?,?)').run(hash(token),user.id,purpose,now()+(purpose==='verify'?86400000:1800000));
  const link=new URL('/app',origin);link.hash=purpose+'='+token;
  try{await getMail()({to:user.email,subject:purpose==='verify'?'Подтвердите email — VetaStart':'Восстановление доступа — VetaStart',
   text:(purpose==='verify'?'Подтвердите адрес почты':'Задайте новый пароль')+':\n'+link.href+
    '\nЕсли вы не запрашивали это действие, проигнорируйте письмо.'});}
  catch{db.prepare('DELETE FROM customer_action_tokens WHERE token_hash=?').run(hash(token));}
 }
 function install(router){
  router.post(['/request-verification','/forgot-password'],async(req,res)=>{
   try{
    getMail();
    const email=typeof req.body?.email==='string'?req.body.email.trim().toLowerCase():'';
    const user=req.db.prepare('SELECT id,email,email_verified_at FROM customers WHERE email=?').get(email);
    const purpose=req.path==='/forgot-password'?'reset':'verify';
    if(user&&(purpose==='reset'||user.email_verified_at===null))await issue(req.db,user,purpose,req.ip||'unknown');
    res.status(202).json(generic);
   }catch{res.sendStatus(503);}
  });
  router.post(['/verify-email','/reset-password'],async(req,res)=>{
   const token=req.body?.token,purpose=req.path==='/verify-email'?'verify':'reset';
   if(typeof token!=='string'||!/^[a-f0-9]{64}$/.test(token))return res.sendStatus(400);
   const password=req.body?.password;
   if(purpose==='reset'&&(typeof password!=='string'||password.length<12||password.length>256))return res.sendStatus(400);
   try{
    initializeRecovery(req.db);
    // Verify cheaply before performing the password KDF; verify again under lock.
    const before=req.db.prepare('SELECT 1 FROM customer_action_tokens WHERE token_hash=? AND purpose=? AND expires_at>?')
     .get(hash(token),purpose,now());
    if(!before)return res.sendStatus(400);
    const salt=purpose==='reset'?crypto.randomBytes(16).toString('hex'):null;
    const digest=purpose==='reset'?(await scrypt(password,salt,64)).toString('hex'):null;
    req.db.exec('BEGIN IMMEDIATE');
    try{
     const row=req.db.prepare(`DELETE FROM customer_action_tokens WHERE token_hash=? AND purpose=? AND expires_at>?
       RETURNING customer_id`).get(hash(token),purpose,now());
     if(!row){req.db.exec('COMMIT');return res.sendStatus(400);}
     if(purpose==='verify'){
      req.db.prepare('UPDATE customers SET email_verified_at=? WHERE id=? AND email_verified_at IS NULL').run(now(),row.customer_id);
      startTrial(req.db,row.customer_id,now());
     }else{
      req.db.prepare('UPDATE customers SET salt=?,password_hash=? WHERE id=?').run(salt,digest,row.customer_id);
      req.db.prepare('DELETE FROM customer_sessions WHERE customer_id=?').run(row.customer_id);
      // Pending OAuth sessions may no longer attach an account after recovery.
      if(req.db.prepare("SELECT 1 FROM sqlite_master WHERE name='instagram_oauth_states'").get())
       req.db.prepare('DELETE FROM instagram_oauth_states WHERE customer_id=?').run(row.customer_id);
     }
     req.db.prepare('DELETE FROM customer_action_tokens WHERE customer_id=? AND purpose=?').run(row.customer_id,purpose);
     req.db.exec('COMMIT');res.json({ok:true});
    }catch(error){req.db.exec('ROLLBACK');throw error;}
   }catch{res.sendStatus(503);}
  });
 }
 return {install,issue,ensureMailer:getMail};
}
module.exports={initializeRecovery,developmentAuth,recoveryService};
