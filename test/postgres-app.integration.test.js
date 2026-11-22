const {test}=require('node:test');const assert=require('node:assert/strict');const crypto=require('node:crypto');
const {prepareStore}=require('../postgres-app/start');const {createApp}=require('../postgres-app/server');
const {runCycle}=require('../postgres-app/automation-runner');
const url=process.env.VETASTART_PG_TEST_URL;
test('PostgreSQL complete customer application',{skip:!url,timeout:60000},async t=>{
 assert.equal(new URL(url).pathname,'/vetastart_test');
 const emails=[],outbound=[];let activeAccount='789';
 const env={DATABASE_URL:url,VETASTART_PG_SCHEMA:'vetastart_app_test',NODE_ENV:'production',
  VETASTART_PUBLIC_ORIGIN:'https://app.example',VETASTART_SIGNUP_ENABLED:'true',INSTAGRAM_LOGIN_MODE:'unified',
  VETASTART_MAIL_ENABLED:'true',SMTP_HOST:'smtp.example.test',SMTP_USER:'fixture',SMTP_PASSWORD:'fixture',MAIL_FROM:'support@example.test',
  INSTAGRAM_CONFIG_ID:'12',META_APP_ID:'123',META_APP_SECRET:'fixture-secret',META_CLIENT_BUSINESS_ID:'456',
  META_GRAPH_API_VERSION:'v27.0',INSTAGRAM_REDIRECT_URI:'https://app.example/auth/instagram/callback',
  INSTAGRAM_VERIFY_TOKEN:'fixture-verify',VETASTART_ADMIN_TOKEN:'fixture-admin-key-at-least-thirty-two-characters',
  VETASTART_TOKEN_KEY:Buffer.alloc(32,4).toString('base64'),
  ROBOKASSA_ENABLED:'true',ROBOKASSA_MERCHANT_LOGIN:'fixture-shop',ROBOKASSA_HASH_ALGORITHM:'sha256',
  ROBOKASSA_TEST_MODE:'false',ROBOKASSA_LIVE_ENABLED:'true',ROBOKASSA_PASSWORD1:'fixture-one',ROBOKASSA_PASSWORD2:'fixture-two'};
 let store=await prepareStore(env);
 const query=store.db.query.bind(store.db);
 store.db.query=async(sql,args)=>{try{return await query(sql,args);}catch(error){console.error('PostgreSQL test query failed:',error.code,error.message,sql);throw error;}};
 const app=createApp({store,env,sendMail:async mail=>emails.push(mail),fetchImpl:async(endpoint,options)=>{
  assert.ok(endpoint.startsWith('https://graph.facebook.com/'));
  if(endpoint.includes('/oauth/access_token'))return Response.json({access_token:'fixture-suat-'+activeAccount,expires_in:86400});
  if(endpoint.endsWith('/me/assigned_instagram_accounts'))return Response.json({data:[{id:activeAccount}]});
  if(endpoint.endsWith('/subscribed_apps'))return Response.json({success:true});
  outbound.push({endpoint,options});return Response.json({message_id:'confirmed-'+outbound.length});
 }});
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const base=`http://127.0.0.1:${server.address().port}`;
 t.after(async()=>{await new Promise(r=>server.close(r));await store.close();});
 const request=async(path,{method='GET',body,cookie,raw,headers={}}={})=>fetch(base+path,{method,redirect:'manual',
  headers:{Origin:env.VETASTART_PUBLIC_ORIGIN,...(cookie?{Cookie:cookie}:{}),...(!raw?{'Content-Type':'application/json'}:{}),...headers},
  body:raw|| (body===undefined?undefined:JSON.stringify(body))});
 async function signup(email){
  const registration=await request('/api/customer/register',{method:'POST',body:{email,password:'fixture-password-long'}});
  assert.equal(registration.status,202,await registration.text());
  const token=new URL(emails.at(-1).text.match(/http[^\s]+/)[0]).hash.split('=')[1];
  const verified=await request('/api/customer/verify-email',{method:'POST',body:{token}});assert.equal(verified.status,200,await verified.text());
  const login=await request('/api/customer/login',{method:'POST',body:{email,password:'fixture-password-long'}});
  assert.equal(login.status,200,await login.text());return login.headers.get('set-cookie').split(';')[0];
 }
 let first,second;
 await t.test('registration, verification, session and trial persist in PostgreSQL',async()=>{
  first=await signup('first@example.test');second=await signup('second@example.test');
  const me=await request('/api/customer/me',{cookie:first});assert.equal(me.status,200);
  assert.equal((await me.json()).subscription.status,'trial');
  const health=await request('/health/ready');assert.equal(health.status,200);
 });
 await t.test('OAuth account ownership, rule and signed webhook feed the PostgreSQL sender',async()=>{
  const start=await request('/auth/instagram/start',{cookie:first,method:'POST'});assert.equal(start.status,200,await start.clone().text());
  const state=new URL((await start.json()).authorizationUrl).searchParams.get('state');
  const oauth=start.headers.get('set-cookie').split(';')[0];
  const callback=await request('/auth/instagram/callback?code=fixture-code&state='+state,{cookie:first+'; '+oauth});
  assert.equal(callback.status,303,await callback.text());
  const denied=await request('/api/admin/instagram/status',{cookie:first});
  assert.equal(denied.status,401);
  const operational=await request('/api/admin/instagram/status',{headers:{Authorization:'Bearer '+env.VETASTART_ADMIN_TOKEN}});
  assert.equal(operational.status,200);
  assert.equal(operational.headers.get('cache-control'),'no-store');
  const summary=await operational.json();
  assert.equal(summary.connections[0].account_id,'789');
  assert.equal(summary.connections[0].connection_status,'active');
  assert.doesNotMatch(JSON.stringify(summary),/fixture-suat|token_cipher|password_hash|fixture-secret/);
  const rule=await request('/api/customer/rules',{cookie:first,method:'POST',body:{accountId:'789',keyword:'гайд',reply:'Ваша ссылка',enabled:true}});
  assert.equal(rule.status,201,await rule.text());
  const body=JSON.stringify({object:'instagram',entry:[{id:'789',messaging:[{timestamp:Date.now(),sender:{id:'321'},recipient:{id:'789'},message:{mid:'m1',text:'ГАЙД'}}]}]});
  for(let n=0;n<2;n++){
   const webhook=await request('/webhooks/instagram',{method:'POST',raw:body,headers:{'Content-Type':'application/json',
    'x-hub-signature-256':'sha256='+crypto.createHmac('sha256',env.META_APP_SECRET).update(body).digest('hex')}});
   assert.equal(webhook.status,200,await webhook.text());
  }
  const result=await runCycle(store,{env:{...env,VETASTART_AUTOMATION_ENABLED:'true',VETASTART_SEND_ENABLED:'true'},fetchImpl:async(endpoint,options)=>{
   outbound.push({endpoint,options});return Response.json({message_id:'sent-confirmed'});
  }});
  assert.equal(result.sent,1);assert.equal(outbound.length,1);
  const bodySent=JSON.parse(outbound[0].options.body);assert.equal(bodySent.message.text,'Ваша ссылка');
  const activity=await(await request('/api/customer/activity',{cookie:first})).json();assert.equal(activity[0].status,'sent');
  assert.deepEqual(await(await request('/api/customer/activity',{cookie:second})).json(),[]);
 });
 await t.test('Robokassa callback grants exactly one period using PostgreSQL identity invoice',async()=>{
  const checkout=await request('/api/customer/billing/checkout',{cookie:first,method:'POST',body:{planId:'start'}});
  assert.equal(checkout.status,200,await checkout.clone().text());
  const link=new URL((await checkout.json()).paymentUrl),sum=link.searchParams.get('OutSum'),id=link.searchParams.get('InvId'),order=link.searchParams.get('Shp_order');
  const signature=crypto.createHash('sha256').update(`${sum}:${id}:${env.ROBOKASSA_PASSWORD2}:Shp_order=${order}`).digest('hex');
  for(let n=0;n<2;n++){
   const result=await request('/webhooks/payments/robokassa',{method:'POST',raw:new URLSearchParams({OutSum:sum,InvId:id,Shp_order:order,SignatureValue:signature}),headers:{'Content-Type':'application/x-www-form-urlencoded'}});
   assert.equal(result.status,200,await result.clone().text());assert.equal(await result.text(),'OK'+id);
  }
  assert.equal((await store.db.prepare("SELECT count(*) AS n FROM subscription_periods WHERE payment_id IS NOT NULL").get()).n,1);
 });
 await t.test('password reset invalidates sessions and trial is not duplicated',async()=>{
  const forgot=await request('/api/customer/forgot-password',{method:'POST',body:{email:'first@example.test'}});assert.equal(forgot.status,202);
  const token=new URL(emails.at(-1).text.match(/http[^\s]+/)[0]).hash.split('=')[1];
  const changed=await request('/api/customer/reset-password',{method:'POST',body:{token,password:'changed-fixture-password'}});
  assert.equal(changed.status,200,await changed.text());
  assert.equal((await request('/api/customer/me',{cookie:first})).status,401);
  assert.equal((await store.db.prepare("SELECT count(*) AS n FROM subscription_periods WHERE plan_id='trial'").get()).n,2);
 });
 await t.test('a new database pool sees all durable data and failed transaction never emits success',async()=>{
  const other=await prepareStore(env);
  try{
   assert.equal((await other.db.prepare('SELECT count(*) AS n FROM customers').get()).n,2);
   assert.equal((await other.db.prepare("SELECT count(*) AS n FROM drafts WHERE status='sent'").get()).n,1);
   let replied=false;await assert.rejects(other.db.transaction(async()=>{
    other.db.afterCommit(()=>{replied=true;});throw new Error('commit not allowed');
   }));assert.equal(replied,false);
  }finally{await other.close();}
 });
 await t.test('second customer cannot claim an Instagram account already connected by the first',async()=>{
  const before=await store.db.prepare('SELECT customer_id FROM customer_accounts WHERE account_id=?').get('789');
  const started=await request('/auth/instagram/start',{cookie:second,method:'POST'});assert.equal(started.status,200);
  const state=new URL((await started.json()).authorizationUrl).searchParams.get('state');
  const cookie=second+'; '+started.headers.get('set-cookie').split(';')[0];
  assert.equal((await request('/auth/instagram/callback?code=other-code&state='+state,{cookie})).status,502);
  assert.equal((await store.db.prepare('SELECT customer_id FROM customer_accounts WHERE account_id=?').get('789')).customer_id,before.customer_id);
 });
 await t.test('last quota slot remains atomic across separate PostgreSQL connection pools',async()=>{
  const owner=(await store.db.prepare('SELECT customer_id FROM customer_accounts WHERE account_id=?').get('789')).customer_id;
  const {access}=require('../postgres-app/subscriptions');
  const sub=await access(store.db,owner);assert.equal(sub.usedMessages,1);
  for(let n=0;n<98;n++)await store.db.prepare('INSERT INTO subscription_usage VALUES (?,?,?)').run('prior-'+n,sub.periodId,Date.now());
  for(const mid of ['quota1','quota2']){
   const event={object:'instagram',entry:[{id:'789',messaging:[{timestamp:Date.now(),sender:{id:'321'},recipient:{id:'789'},message:{mid,text:'гайд'}}]}]};
   await store.receive(Buffer.from(JSON.stringify(event)),event);
  }
  await require('../postgres-app/worker').processPending(store,{env});
  const other=await prepareStore(env);let sent=0;
  try{
   const {sendDrafts}=require('../postgres-app/sender');
   const options={env:{...env,INSTAGRAM_ACCOUNT_ID:'789',VETASTART_SEND_ENABLED:'true'},fetchImpl:async()=>{
    sent++;return Response.json({message_id:'quota-confirmed'});
   }};
   await Promise.all([sendDrafts(store,options),sendDrafts(other,options)]);
   assert.equal(sent,1);assert.equal((await access(store.db,owner)).usedMessages,100);
  }finally{await other.close();}
 });
 await t.test('normal npm start entry chooses PostgreSQL and shuts down cleanly',async()=>{
  const {spawn}=require('node:child_process');const {once}=require('node:events');const {createInterface}=require('node:readline');
  const child=spawn(process.execPath,[require('node:path').join(__dirname,'..','server.js')],{env:{...process.env,...env,
   PORT:'0',VETASTART_SIGNUP_ENABLED:'false',VETASTART_MAIL_ENABLED:'false',VETASTART_AUTOMATION_ENABLED:'false',VETASTART_SEND_ENABLED:'false',ROBOKASSA_ENABLED:'false'},stdio:['ignore','pipe','pipe']});
  const closed=once(child,'close');const lines=createInterface({input:child.stdout});
  try{
   const port=await new Promise((resolve,reject)=>{lines.on('line',line=>{const match=/started on port (\d+)/.exec(line);if(match)resolve(match[1]);});child.once('error',reject);child.once('exit',()=>reject(new Error('PostgreSQL service exited before start')));});
   assert.equal((await fetch('http://127.0.0.1:'+port+'/health/ready')).status,200);
   child.kill('SIGTERM');assert.equal((await closed)[0],0);
  }finally{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await closed;}}
 });
 await t.test('legacy user hashes and draft projects are preserved without trusting old sessions',async()=>{
  const salt='ab'.repeat(16),password='legacy-fixture-password',encoded=salt+':'+crypto.scryptSync(password,salt,64).toString('hex');
  await store.db.query(`CREATE TABLE public.users(id BIGINT PRIMARY KEY,email TEXT,password_hash TEXT);
    CREATE TABLE public.instagram_accounts(id BIGINT PRIMARY KEY,user_id BIGINT,name TEXT);
    CREATE TABLE public.scenarios(id BIGINT PRIMARY KEY,account_id BIGINT,name TEXT,keyword TEXT,
      trigger_source TEXT,messages JSONB,choices JSONB,follow_gate BOOLEAN);`);
  await store.db.query('INSERT INTO public.users VALUES(1,$1,$2)',['legacy@example.test',encoded]);
  await store.db.query("INSERT INTO public.instagram_accounts VALUES(1,1,'Старый проект')");
  await store.db.query(`INSERT INTO public.scenarios VALUES(1,1,'Старый сценарий','ГАЙД','both',$1::jsonb,'[]'::jsonb,false)`,[JSON.stringify(['Сохранённое сообщение'])]);
  const {importLegacyUsers}=require('../postgres-app/legacy');
  assert.equal((await importLegacyUsers(store.db)).imported,1);assert.equal((await importLegacyUsers(store.db)).imported,0);
  assert.equal((await request('/api/customer/login',{method:'POST',body:{email:'legacy@example.test',password}})).status,403);
  await request('/api/customer/request-verification',{method:'POST',body:{email:'legacy@example.test'}});
  const token=new URL(emails.at(-1).text.match(/http[^\s]+/)[0]).hash.split('=')[1];
  assert.equal((await request('/api/customer/verify-email',{method:'POST',body:{token}})).status,200);
  const login=await request('/api/customer/login',{method:'POST',body:{email:'legacy@example.test',password}});assert.equal(login.status,200);
  const cookie=login.headers.get('set-cookie').split(';')[0];
  const projects=await(await request('/api/customer/legacy-projects',{cookie})).json();
  assert.equal(projects[0].scenarios[0].messages[0],'Сохранённое сообщение');
  assert.deepEqual(await(await request('/api/customer/legacy-projects',{cookie:second})).json(),[]);
  assert.equal((await store.db.query('SELECT password_hash FROM public.users')).rows[0].password_hash,encoded);
 });
});
