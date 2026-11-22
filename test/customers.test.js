const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server');
const { AutomationStore } = require('../automation');
const { bindAccount, customerRules } = require('../customers');

async function setup(t) {
  const store = new AutomationStore(':memory:');
  const env = { VETASTART_AUTH_DEV_MODE:'true', VETASTART_SIGNUP_ENABLED:'true', INSTAGRAM_LOGIN_MODE:'unified', INSTAGRAM_CONFIG_ID:'12',
    META_APP_ID:'123', META_APP_SECRET:'test-secret', META_CLIENT_BUSINESS_ID:'456', META_GRAPH_API_VERSION:'v27.0',
    INSTAGRAM_REDIRECT_URI:'https://example.test/auth/instagram/callback',
    VETASTART_ADMIN_TOKEN:'test-admin-key-at-least-thirty-two-characters', VETASTART_TOKEN_KEY:Buffer.alloc(32,2).toString('base64') };
  const app = createApp({store,env,fetchImpl:async url=>Response.json(url.includes('/oauth/')
    ? {access_token:'test-suat',expires_in:86400} : {data:[{id:'789'}]})});
  const server=app.listen(0,'127.0.0.1'); await new Promise(r=>server.once('listening',r));
  const base=`http://127.0.0.1:${server.address().port}`;env.VETASTART_PUBLIC_ORIGIN=base;
  t.after(async()=>{await new Promise(r=>server.close(r));store.close();});
  async function request(path,{cookie,method='GET',body,origin=base}={}) {
    return fetch(base+path,{method,redirect:'manual',headers:{Origin:origin,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:body===undefined?undefined:JSON.stringify(body)});
  }
  async function signup(email) {
    const result=await request('/api/customer/register',{method:'POST',body:{email,password:'test-password-long-enough'}});
    assert.equal(result.status,200);
    return result.headers.get('set-cookie').split(';')[0];
  }
  return {store,env,request,signup};
}

test('customer sessions hash passwords/tokens, authenticate and invalidate on logout',async t=>{
 const {store,request,signup}=await setup(t);
 const cookie=await signup('owner@example.test');
 assert.equal((await request('/api/customer/me',{cookie})).status,200);
 const user=store.db.prepare('SELECT * FROM customers').get();
 assert.notEqual(user.password_hash,'test-password-long-enough');
 assert.ok(!store.db.prepare('SELECT session_hash FROM customer_sessions').get().session_hash.includes(cookie.split('=')[1]));
 const login=await request('/api/customer/login',{method:'POST',body:{email:'owner@example.test',password:'test-password-long-enough'}});
 assert.equal(login.status,200);
 assert.equal((await request('/api/customer/login',{method:'POST',body:{email:'owner@example.test',password:'wrong-password-long'}})).status,401);
 assert.equal((await request('/api/customer/logout',{cookie,method:'POST'})).status,200);
 assert.equal((await request('/api/customer/me',{cookie})).status,401);
});

test('customers cannot list, create or delete another customer account/rules',async t=>{
 const {store,request,signup}=await setup(t);
 const first=await signup('first@example.test'),second=await signup('second@example.test');
 const owner=store.db.prepare('SELECT id FROM customers WHERE email=?').get('first@example.test').id;
 bindAccount(store.db,'789',owner);
 const input={accountId:'789',keyword:'ГАЙД',reply:'Личный ответ',enabled:true};
 assert.equal((await request('/api/customer/rules',{cookie:second,method:'POST',body:input})).status,403);
 const created=await request('/api/customer/rules',{cookie:first,method:'POST',body:input});assert.equal(created.status,201);
 const {id}=await created.json();
 const event={entry:[{id:'789',messaging:[{timestamp:Date.now(),sender:{id:'123'},recipient:{id:'789'},message:{mid:'m',text:'гайд'}}]}]};
 store.receive(Buffer.from(JSON.stringify(event)),event);store.process(customerRules(store.db));
 assert.equal((await (await request('/api/customer/activity',{cookie:first})).json()).length,1);
 assert.deepEqual(await (await request('/api/customer/activity',{cookie:second})).json(),[]);
 assert.deepEqual(await (await request('/api/customer/rules',{cookie:second})).json(),[]);
 assert.deepEqual(await (await request('/api/customer/accounts',{cookie:second})).json(),[]);
 assert.equal((await request('/api/customer/rules/'+id,{cookie:second,method:'DELETE'})).status,404);
 assert.equal(customerRules(store.db).length,1);
 assert.throws(()=>bindAccount(store.db,'789','another-owner'));
 assert.throws(()=>bindAccount(store.db,'789',null));
 assert.equal((await request('/api/customer/rules/'+id,{cookie:first,method:'DELETE'})).status,204);
});

test('customer OAuth binds an account to its initiating session and rejects takeover',async t=>{
 const {store,request,signup}=await setup(t);
 const first=await signup('first@example.test'),second=await signup('second@example.test');
 async function authorize(cookie) {
   const start=await request('/auth/instagram/start',{cookie,method:'POST'});assert.equal(start.status,200);
   const state=new URL((await start.json()).authorizationUrl).searchParams.get('state');
   const oauth=start.headers.get('set-cookie').split(';')[0];
   return {state,cookies:cookie+'; '+oauth};
 }
 const flow=await authorize(first);
 const result=await request('/auth/instagram/callback?state='+flow.state+'&code=test-code',{cookie:flow.cookies});
 assert.equal(result.status,303);
 const accounts=await (await request('/api/customer/accounts',{cookie:first})).json();
 assert.deepEqual(accounts,[{account_id:'789'}]);
 const takeover=await authorize(second);
 assert.equal((await request('/auth/instagram/callback?state='+takeover.state+'&code=test-code',{cookie:takeover.cookies})).status,502);
 assert.equal(store.db.prepare('SELECT count(*) AS n FROM customer_accounts').get().n,1);
 const loggedOut=await authorize(first);
 await request('/api/customer/logout',{cookie:first,method:'POST'});
 assert.equal((await request('/auth/instagram/callback?state='+loggedOut.state+'&code=test-code',{cookie:loggedOut.cookies})).status,401);
});

test('CSRF checks, signup gate, authentication and brute-force limits fail closed',async t=>{
 const {env,request}=await setup(t);
 assert.equal((await request('/api/customer/register',{origin:'https://foreign.test',method:'POST',body:{}})).status,403);
 assert.equal((await request('/api/customer/rules')).status,401);
 env.VETASTART_SIGNUP_ENABLED='false';
 assert.equal((await request('/api/customer/register',{method:'POST',body:{email:'a@example.test',password:'long-enough-password'}})).status,403);
 for(let i=0;i<19;i++) await request('/api/customer/login',{method:'POST',body:{email:'a@example.test',password:'long-enough-password'}});
 assert.equal((await request('/api/customer/login',{method:'POST',body:{email:'a@example.test',password:'long-enough-password'}})).status,429);
});

test('rule limits and expired trial are enforced by API; no public payment grant exists',async t=>{
 const {store,request,signup}=await setup(t);
 const cookie=await signup('limited@example.test');
 const owner=store.db.prepare('SELECT id FROM customers').get().id;bindAccount(store.db,'789',owner);
 const input={accountId:'789',keyword:'гайд',reply:'Ссылка',enabled:true};
 for(let i=0;i<3;i++)assert.equal((await request('/api/customer/rules',{cookie,method:'POST',body:input})).status,201);
 const limit=await request('/api/customer/rules',{cookie,method:'POST',body:input});
 assert.equal(limit.status,409);assert.equal((await limit.json()).error,'rule_limit_reached');
 store.db.prepare('UPDATE subscription_periods SET end_at=?').run(Date.now()-1);
 assert.equal((await request('/api/customer/rules',{cookie,method:'POST',body:input})).status,402);
 assert.equal((await (await request('/api/customer/me',{cookie})).json()).subscription.active,false);
 assert.equal((await request('/api/customer/subscribe',{cookie,method:'POST',body:{planId:'pro',status:'succeeded'}})).status,404);
});

test('billing checkout requires customer session and provider setup; invoices remain private',async t=>{
 const {env,request,signup}=await setup(t);
 const first=await signup('payer@example.test'),second=await signup('other@example.test');
 assert.equal((await request('/api/customer/billing')).status,401);
 assert.equal((await request('/api/customer/billing/checkout',{cookie:first,method:'POST',body:{planId:'start'}})).status,503);
 Object.assign(env,{ROBOKASSA_ENABLED:'true',ROBOKASSA_MERCHANT_LOGIN:'test',ROBOKASSA_HASH_ALGORITHM:'sha256',
   ROBOKASSA_TEST_PASSWORD1:'test-one',ROBOKASSA_TEST_PASSWORD2:'test-two'});
 const checkout=await request('/api/customer/billing/checkout',{cookie:first,method:'POST',body:{planId:'start',amount:1}});
 assert.equal(checkout.status,200);assert.equal(new URL((await checkout.json()).paymentUrl).searchParams.get('OutSum'),'990.00');
 assert.equal((await (await request('/api/customer/billing',{cookie:first})).json()).invoices.length,1);
 assert.equal((await (await request('/api/customer/billing',{cookie:second})).json()).invoices.length,0);
});
