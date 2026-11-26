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
    ? {access_token:'test-suat',expires_in:86400} : url.endsWith('/subscribed_apps')?{success:true}:{data:[{id:'789'}]})});
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
 assert.equal(checkout.status,200);assert.equal(new URL((await checkout.json()).paymentUrl).searchParams.get('OutSum'),'590.00');
 const catalog=await (await request('/api/customer/billing',{cookie:first})).json();
 assert.deepEqual(catalog.plans.map(plan=>[plan.id,plan.price,plan.extraAccountPrice,plan.messages]),[['start',59000,10000,null]]);
 const extra=await request('/api/customer/billing/checkout',{method:'POST',cookie:first,body:{planId:'start',accounts:3}});
 assert.equal(extra.status,200);
 assert.equal(new URL((await extra.json()).paymentUrl).searchParams.get('OutSum'),'790.00');
 for(const body of [{planId:'business'},{planId:'start',accounts:0},{planId:'start',accounts:11},{planId:'start',accounts:'2'}]) {
  assert.equal((await request('/api/customer/billing/checkout',{method:'POST',cookie:first,body})).status,400);
 }

 assert.equal((await (await request('/api/customer/billing',{cookie:first})).json()).invoices.length,2);
 assert.equal((await (await request('/api/customer/billing',{cookie:second})).json()).invoices.length,0);
});

test('Direct rules persist three buttons, preview a PDF and send a Meta template', async t => {
 const {store, env, request, signup} = await setup(t);
 const owner = await signup('buttons@example.test');
 const other = await signup('other@example.test');
 bindAccount(store.db, '789', store.db.prepare('SELECT id FROM customers WHERE email=?').get('buttons@example.test').id);
 const pdf = Buffer.from('%PDF-1.4\n%%EOF\n');
 const rule = {
  accountId: '789', keyword: 'гайд', reply: 'Привет! Что хотите выбрать?', enabled: true,
  buttons: [
   {type: 'pdf', title: 'Промпт', data: pdf.toString('base64'), filename: 'Промпт.pdf'},
   {type: 'url', title: 'Курс', url: 'https://vetastart.ru/'},
   {type: 'url', title: 'Консультация', url: 'https://t.me/violettaproekti'}
  ]
 };
 const saved = await request('/api/customer/rules', {method:'POST', cookie:owner, body:rule});
 assert.equal(saved.status, 201, await saved.clone().text());
 const {id} = await saved.json();
 const preview = await request('/api/customer/rules/preview', {
  method: 'POST', cookie: owner, body: {accountId:'789', phrase:'хочу гаайд'}
 });
 assert.equal(preview.status, 200);
 const [match] = (await preview.json()).matches;
 assert.equal(match.id, id);
 assert.deepEqual(match.buttons.map(button => button.title), ['Промпт','Курс','Консультация']);
 assert.equal(match.buttons[0].data, undefined);

 const path = '/automation-files/' + match.buttons[0].fileId;
 const downloaded = await request(path);
 assert.equal(downloaded.status, 200);
 assert.match(downloaded.headers.get('content-type'), /^application\/pdf/);
 assert.match(downloaded.headers.get('content-disposition'), /^attachment/);
 assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), pdf);
 const edit = await request('/api/customer/rules/' + id, {
  method:'PATCH', cookie:other, body:{...rule, buttons:match.buttons}
 });
 assert.equal(edit.status, 404);
 const invalid = await request('/api/customer/rules/' + id, {
  method:'PATCH', cookie:owner, body:{...rule, buttons:[{type:'url', title:'Ссылка', url:'javascript:alert(1)'}]}
 });
 assert.equal(invalid.status, 400);

 const event = {entry:[{id:'789', messaging:[{timestamp:Date.now(), sender:{id:'123'},
  recipient:{id:'789'}, message:{mid:'buttons-msg', text:'гаайд'}}]}]};
 store.receive(Buffer.from(JSON.stringify(event)), event);
 assert.equal(store.process(customerRules(store.db)).drafts, 1);
 const outbound = [];
 const {sendDrafts} = require('../sender');
 const counts = await sendDrafts(store, {
  env:{...env,VETASTART_SEND_ENABLED:'true',INSTAGRAM_ACCESS_TOKEN:'fixture-token',INSTAGRAM_ACCOUNT_ID:'789'},
  fetchImpl:async (_url, options) => {
   outbound.push(JSON.parse(options.body));
   return Response.json({message_id:'fixture-message'});
  }
 });
 assert.equal(counts.sent, 1);
 const template = outbound[0].message.attachment.payload;
 assert.equal(template.template_type, 'button');
 assert.equal(template.text, rule.reply);
 assert.deepEqual(template.buttons, [
  {type:'web_url',title:'Промпт',url:env.VETASTART_PUBLIC_ORIGIN + path},
  {type:'web_url',title:'Курс',url:'https://vetastart.ru/'},
  {type:'web_url',title:'Консультация',url:'https://t.me/violettaproekti'}
 ]);
 const gate = await request('/api/customer/rules/' + id, {
  method:'PATCH', cookie:owner, body:{enabled:true, requireFollow:true}
 });
 assert.equal(gate.status, 204);
 const gatedPreview = await request('/api/customer/rules/preview', {
  method:'POST', cookie:owner, body:{accountId:'789', phrase:'гайд'}
 });
 const [gatedRule] = (await gatedPreview.json()).matches;
 assert.equal(gatedRule.requireFollow, true);
 assert.deepEqual(gatedRule.buttons, match.buttons);
 const senderOptions = {
  env:{...env,VETASTART_SEND_ENABLED:'true',INSTAGRAM_ACCESS_TOKEN:'fixture-token',INSTAGRAM_ACCOUNT_ID:'789'}
 };
 for (const [index, follow] of [false,true,null].entries()) {
  event.entry[0].messaging[0].message.mid = 'gated-' + index;
  store.receive(Buffer.from(JSON.stringify(event)), event);
  assert.equal(store.process(customerRules(store.db)).drafts, 1);
  const requests = [];
  const result = await sendDrafts(store, {...senderOptions, fetchImpl:async (url, options) => {
   requests.push({url, options});
   if (options.method === 'GET') {
    return follow === null ? new Response('',{status:503}) : Response.json({is_user_follow_business:follow});
   }
   return Response.json({message_id:'gated-fixture'});
  }});
  assert.equal(result.sent, 1);
  assert.equal(requests.length, 2);
  assert.match(requests[0].url, /\/123\?fields=is_user_follow_business$/);
  const sent = JSON.parse(requests[1].options.body).message;
  if (follow === true) {
   assert.deepEqual(sent.attachment.payload.buttons, template.buttons);
  } else {
   assert.equal(sent.attachment, undefined);
   assert.match(sent.text, follow === false ? /подпишитесь/ : /не удалось проверить/);
  }
 }
 assert.equal((await request('/api/customer/rules/' + id, {method:'DELETE',cookie:owner})).status, 204);
 assert.equal((await request(path)).status, 404);
});
