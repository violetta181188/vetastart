const {test}=require('node:test');const assert=require('node:assert/strict');
const {createApp}=require('../server');const {AutomationStore}=require('../automation');
const {developmentAuth}=require('../account-recovery');const {createMailer}=require('../mailer');
async function setup(t,{sendFailure=false,inject=true}={}){
 const store=new AutomationStore(':memory:'),emails=[];let time=1800000000000;
 const env={VETASTART_SIGNUP_ENABLED:'true'};
 const app=createApp({store,env,now:()=>time,...(inject?{sendMail:async msg=>{if(sendFailure)throw new Error('private-smtp-secret');emails.push(msg);}}:{})});
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const base=`http://127.0.0.1:${server.address().port}`;env.VETASTART_PUBLIC_ORIGIN=base;
 t.after(async()=>{await new Promise(r=>server.close(r));store.close();});
 async function request(route,body,cookie){return fetch(base+'/api/customer/'+route,{method:body===undefined?'GET':'POST',
  headers:{Origin:base,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:body===undefined?undefined:JSON.stringify(body)});}
 const register=()=>request('register',{email:'client@example.test',password:'initial-password-long'});
 const token=()=>new URL(emails.at(-1).text.match(/http[^\s]+/)[0]).hash.split('=')[1];
 return {store,emails,env,request,register,token,advance:ms=>{time+=ms;}};
}
test('registration requires email confirmation, keeps only token hash and starts trial on confirmation',async t=>{
 const {store,request,register,token,emails}=await setup(t);
 const registration=await register();assert.equal(registration.status,202);assert.equal(registration.headers.get('set-cookie'),null);
 assert.equal(emails.length,1);const proof=token();
 assert.ok(!store.db.prepare('SELECT token_hash FROM customer_action_tokens').get().token_hash.includes(proof));
 assert.equal(store.db.prepare('SELECT email_verified_at FROM customers').get().email_verified_at,null);
 assert.equal((await request('login',{email:'client@example.test',password:'initial-password-long'})).status,403);
 assert.equal((await request('verify-email',{token:proof})).status,200);
 assert.equal((await request('verify-email',{token:proof})).status,400);
 const login=await request('login',{email:'client@example.test',password:'initial-password-long'});assert.equal(login.status,200);
 const cookie=login.headers.get('set-cookie').split(';')[0];
 assert.equal((await (await request('me',undefined,cookie)).json()).subscription.status,'trial');
 assert.equal(store.db.prepare('SELECT count(*) AS n FROM subscription_periods').get().n,1);
});
test('password reset is single-use, rejects wrong purpose and revokes all old sessions',async t=>{
 const {store,request,register,token}=await setup(t);await register();await request('verify-email',{token:token()});
 const login=await request('login',{email:'client@example.test',password:'initial-password-long'});
 const cookie=login.headers.get('set-cookie').split(';')[0];
 await request('forgot-password',{email:'client@example.test'});const reset=token();
 assert.equal((await request('verify-email',{token:reset})).status,400);
 assert.equal((await request('reset-password',{token:reset,password:'new-strong-password'})).status,200);
 assert.equal((await request('reset-password',{token:reset,password:'another-new-password'})).status,400);
 assert.equal((await request('me',undefined,cookie)).status,401);
 assert.equal(store.db.prepare('SELECT count(*) AS n FROM customer_sessions').get().n,0);
 assert.equal((await request('login',{email:'client@example.test',password:'initial-password-long'})).status,401);
 assert.equal((await request('login',{email:'client@example.test',password:'new-strong-password'})).status,200);
});
test('expired verification/reset tokens fail; recovery does not reveal nonexistent users in response',async t=>{
 const {request,register,token,advance}=await setup(t);await register();const old=token();advance(86400001);
 assert.equal((await request('verify-email',{token:old})).status,400);
 const known=await (await request('forgot-password',{email:'client@example.test'})).json();
 const reset=token();const unknown=await (await request('forgot-password',{email:'unknown@example.test'})).json();
 assert.deepEqual(known,unknown);advance(1800001);
 assert.equal((await request('reset-password',{token:reset,password:'new-strong-password'})).status,400);
});
test('SMTP failure leaves account unverified, removes undelivered token, never grants trial',async t=>{
 const {store,register}=await setup(t,{sendFailure:true});assert.equal((await register()).status,202);
 assert.equal(store.db.prepare('SELECT count(*) AS n FROM customer_action_tokens').get().n,0);
 assert.equal(store.db.prepare('SELECT email_verified_at FROM customers').get().email_verified_at,null);
 assert.equal(store.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='subscription_periods'").get().n,0);
});
test('verification email requests are bounded, missing mail setup fails closed',async t=>{
 const {request,register,emails}=await setup(t);await register();
 for(let n=0;n<5;n++)assert.equal((await request('request-verification',{email:'client@example.test'})).status,202);
 assert.equal(emails.length,3);
 const missing=await setup(t,{inject:false});assert.equal((await missing.register()).status,503);
 assert.equal(missing.store.db.prepare('SELECT count(*) AS n FROM customers').get().n,0);
 assert.equal(developmentAuth({VETASTART_AUTH_DEV_MODE:'true',VETASTART_PUBLIC_ORIGIN:'https://public.example'}),false);
});
test('SMTP transport requires TLS and never allows arbitrary file or URL attachments',async()=>{
 let settings,message;
 const env={VETASTART_MAIL_ENABLED:'true',SMTP_HOST:'smtp.example.test',SMTP_PORT:'587',SMTP_USER:'test-user',SMTP_PASSWORD:'fixture-only',MAIL_FROM:'support@example.test'};
 const mail=createMailer(env,{createTransport:options=>{settings=options;return{sendMail:async msg=>{message=msg;return{accepted:['client@example.test']};}};}});
 await mail({to:'client@example.test',text:'Test'});assert.equal(settings.requireTLS,true);assert.equal(settings.secure,false);
 assert.equal(message.disableFileAccess,true);assert.equal(message.disableUrlAccess,true);assert.equal(settings.logger,false);
 assert.throws(()=>createMailer({...env,SMTP_PORT:'25'}));assert.throws(()=>createMailer({}));
});
