const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {AutomationStore}=require('../automation');
const {initializeCustomers}=require('../customers');
const {createCheckout,acceptResult,kopeks}=require('../robokassa');
const {createApp}=require('../server');
const env={ROBOKASSA_ENABLED:'true',ROBOKASSA_MERCHANT_LOGIN:'test-merchant',ROBOKASSA_HASH_ALGORITHM:'sha256',
 ROBOKASSA_TEST_PASSWORD1:'sandbox-one',ROBOKASSA_TEST_PASSWORD2:'sandbox-two',
 ROBOKASSA_PASSWORD1:'live-fixture-one',ROBOKASSA_PASSWORD2:'live-fixture-two'};
function setup(t){const store=new AutomationStore(':memory:');t.after(()=>store.close());initializeCustomers(store.db);
 store.db.prepare('INSERT INTO customers (id,email,salt,password_hash) VALUES (?,?,?,?)').run('customer','payer@example.test','salt','hash');return store;}
function fields(checkout,options=env){const url=new URL(checkout.paymentUrl);const sum=url.searchParams.get('OutSum');
 const order=url.searchParams.get('Shp_order'),id=String(checkout.invoiceId);
 const password=checkout.isTest?options.ROBOKASSA_TEST_PASSWORD2:options.ROBOKASSA_PASSWORD2;
 return {OutSum:sum,InvId:id,Shp_order:order,SignatureValue:crypto.createHash('sha256').update(`${sum}:${id}:${password}:Shp_order=${order}`).digest('hex')};}

test('checkout is server-priced, signed, reuses pending invoice and never exposes passwords',t=>{
 const store=setup(t);const checkout=createCheckout(store.db,'customer','start',env,1000);
 const url=new URL(checkout.paymentUrl);
 assert.equal(url.origin+url.pathname,'https://auth.robokassa.ru/Merchant/Index.aspx');
 assert.equal(url.searchParams.get('OutSum'),'590.00');assert.equal(url.searchParams.get('IsTest'),'1');
 assert.equal(url.searchParams.get('SignatureValue'),crypto.createHash('sha256').update(
  `test-merchant:590.00:${checkout.invoiceId}:sandbox-one:Shp_order=${url.searchParams.get('Shp_order')}`).digest('hex'));
 assert.ok(!url.href.includes('sandbox-one'));assert.ok(!url.href.includes('sandbox-two'));
 assert.equal(createCheckout(store.db,'customer','start',env,1001).invoiceId,checkout.invoiceId);
 assert.throws(()=>createCheckout(store.db,'customer','trial',env));
 assert.throws(()=>createCheckout(store.db,'customer','business',env));
 assert.throws(()=>createCheckout(store.db,'customer','pro',env));
 assert.equal(new URL(createCheckout(store.db,'customer','start_2',env,1002).paymentUrl).searchParams.get('OutSum'),'690.00');

 assert.throws(()=>createCheckout(store.db,'customer','__proto__',env));
 assert.throws(()=>createCheckout(store.db,'customer','start',{...env,ROBOKASSA_TEST_MODE:'false'}));
});
test('sandbox payment never grants access, including mode change and forged IsTest',t=>{
 const store=setup(t);const checkout=createCheckout(store.db,'customer','start',env);
 const result=fields(checkout);
 assert.equal(acceptResult(store.db,{...result,IsTest:'0'},env),'OK'+checkout.invoiceId);
 acceptResult(store.db,result,{...env,ROBOKASSA_TEST_MODE:'false',ROBOKASSA_LIVE_ENABLED:'true'});
 assert.equal(store.db.prepare('SELECT status FROM robokassa_invoices').get().status,'test_paid');
 assert.equal(store.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='subscription_periods'").get().n,0);
});
test('live signed result grants once and still processes pending invoices after new checkout is disabled',t=>{
 const store=setup(t);const live={...env,ROBOKASSA_TEST_MODE:'false',ROBOKASSA_LIVE_ENABLED:'true'};
 const checkout=createCheckout(store.db,'customer','start_3',live,1000),result=fields(checkout,live);
 const disabled={...live,ROBOKASSA_ENABLED:'false',ROBOKASSA_LIVE_ENABLED:'false'};
 assert.equal(acceptResult(store.db,result,disabled,2000),'OK'+checkout.invoiceId);
 acceptResult(store.db,result,disabled,3000);
 const rows=store.db.prepare('SELECT * FROM subscription_periods').all();assert.equal(rows.length,1);
 assert.equal(rows[0].plan_id,'start_3');assert.equal(rows[0].start_at,2000);assert.equal(rows[0].end_at,2000+30*86400000);
 assert.equal(store.db.prepare('SELECT status FROM robokassa_invoices').get().status,'paid');
});
test('wrong signature, sum, invoice, custom fields and sandbox signature cannot grant live access',t=>{
 const store=setup(t);const live={...env,ROBOKASSA_TEST_MODE:'false',ROBOKASSA_LIVE_ENABLED:'true'};
 const checkout=createCheckout(store.db,'customer','start_2',live),result=fields(checkout,live);
 for(const override of [{SignatureValue:'bad'},{OutSum:'1.00'},{InvId:'999'},{Shp_order:'other'},{Shp_extra:'unexpected'},
  {SignatureValue:fields({...checkout,isTest:true},env).SignatureValue}])
  assert.throws(()=>acceptResult(store.db,{...result,...override},live));
 assert.equal(store.db.prepare('SELECT status FROM robokassa_invoices').get().status,'pending');
});
test('currency conversion accepts provider trailing zeros without rounding fractional kopeks',()=>{
 assert.equal(kopeks('990.000000'),99000);assert.equal(kopeks('990'),99000);
 for(const raw of ['1.001','NaN','-1.00','1e3','0.009',{},['990.00']])assert.throws(()=>kopeks(raw));
});
test('HTTP ResultURL validates form signatures; browser return never grants access',async t=>{
 const store=setup(t);const app=createApp({store,env});const server=app.listen(0,'127.0.0.1');
 await new Promise(r=>server.once('listening',r));t.after(()=>new Promise(r=>server.close(r)));
 const base=`http://127.0.0.1:${server.address().port}`;
 const checkout=createCheckout(store.db,'customer','start',env),result=fields(checkout);
 assert.equal((await fetch(base+'/billing/return?OutSum=990&InvId=1&status=succeeded')).status,200);
 assert.equal(store.db.prepare('SELECT status FROM robokassa_invoices').get().status,'pending');
 const bad=await fetch(base+'/webhooks/payments/robokassa',{method:'POST',body:new URLSearchParams({...result,SignatureValue:'bad'})});
 assert.equal(bad.status,400);
 const good=await fetch(base+'/webhooks/payments/robokassa',{method:'POST',body:new URLSearchParams(result)});
 assert.equal(good.status,200);assert.equal(await good.text(),'OK'+checkout.invoiceId);
});

test('existing Start invoices are still recognized at their original 990 ruble price',t=>{
 const store=setup(t);
 const live={...env,ROBOKASSA_TEST_MODE:'false',ROBOKASSA_LIVE_ENABLED:'true'};
 const checkout=createCheckout(store.db,'customer','start',live,1000);
 store.db.prepare('UPDATE robokassa_invoices SET amount=? WHERE id=?').run(99000,checkout.invoiceId);
 const paymentUrl=new URL(checkout.paymentUrl);
 paymentUrl.searchParams.set('OutSum','990.00');
 const result=fields({...checkout,paymentUrl:paymentUrl.href},live);
 assert.equal(acceptResult(store.db,result,live,2000),'OK'+checkout.invoiceId);
 assert.equal(store.db.prepare('SELECT plan_id FROM subscription_periods').get().plan_id,'start');
});
