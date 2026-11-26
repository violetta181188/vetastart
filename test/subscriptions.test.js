const { test } = require('node:test');
const assert = require('node:assert/strict');
const { AutomationStore } = require('../automation');
const { initializeCustomers } = require('../customers');
const { startTrial,access,applyVerifiedPayment,requireAccountSlot,reserveSend } = require('../subscriptions');
const day=86400000,time=1800000000000;
function setup(t) {
 const store=new AutomationStore(':memory:');t.after(()=>store.close());initializeCustomers(store.db);
 store.db.prepare('INSERT INTO customers (id,email,salt,password_hash) VALUES (?,?,?,?)').run('customer','client@example.test','salt','hash');
 startTrial(store.db,'customer',time);
 store.db.prepare('INSERT INTO customer_accounts VALUES (?,?)').run('123','customer');
 store.db.prepare('INSERT INTO customer_rules VALUES (?,?,?,?,?,1)').run('guide','customer','123','гайд','Ссылка');
 const payload={entry:[{id:'123',messaging:[{timestamp:time,sender:{id:'456'},recipient:{id:'123'},message:{mid:'m',text:'гайд'}}]}]};
 store.receive(Buffer.from(JSON.stringify(payload)),payload);
 store.process([{id:'guide',accountId:'123',trigger:'message',keyword:'гайд',reply:'Ссылка'}]);
 return store;
}
test('trial is issued only once and stops exactly at its expiry',t=>{
 const store=setup(t);startTrial(store.db,'customer',time+day);
 const sub=access(store.db,'customer',time);
 assert.equal(sub.status,'trial');assert.equal(sub.endAt,time+7*day);assert.equal(sub.limits.messages,100);
 assert.equal(access(store.db,'customer',time+7*day).active,false);
 assert.equal(store.db.prepare('SELECT count(*) AS n FROM subscription_periods').get().n,1);
});
test('confirmed payment queues a paid period; duplicate receipt never extends twice',t=>{
 const store=setup(t);
 const payment={customerId:'customer',paymentId:'provider:payment-1',planId:'start',amount:59000,currency:'RUB',status:'succeeded'};
 assert.deepEqual(applyVerifiedPayment(store.db,payment,time),{duplicate:false});
 assert.deepEqual(applyVerifiedPayment(store.db,payment,time),{duplicate:true});
 assert.equal(access(store.db,'customer',time).planId,'trial');
 assert.equal(access(store.db,'customer',time+7*day).planId,'start');
 assert.equal(access(store.db,'customer',time+37*day).active,false);
 for(const override of [{amount:1},{status:'pending'},{planId:'trial'},{currency:'USD'},{customerId:'unknown'}])
   assert.throws(()=>applyVerifiedPayment(store.db,{...payment,...override},time));
});
test('account limit is shared across client accounts and existing account can reconnect',t=>{
 const store=setup(t);
 assert.doesNotThrow(()=>requireAccountSlot(store.db,'customer','123',time));
 assert.throws(()=>requireAccountSlot(store.db,'customer','999',time));
 assert.throws(()=>requireAccountSlot(store.db,'customer','123',time+7*day));
});
test('quota reservation and claim are atomic; last allowed attempt cannot be reused',t=>{
 const store=setup(t);const period=access(store.db,'customer',time).periodId;
 for(let i=0;i<99;i++)store.db.prepare('INSERT INTO subscription_usage VALUES (?,?,?)').run('previous-'+i,period,time);
 const draft=store.db.prepare('SELECT id FROM drafts').get().id;
 assert.equal(reserveSend(store.db,'customer',draft,time),true);
 assert.equal(reserveSend(store.db,'customer',draft,time),false);
 assert.equal(access(store.db,'customer',time).usedMessages,100);
 assert.equal(store.db.prepare('SELECT status FROM drafts').get().status,'sending');
});
test('expired access or exhausted quota leaves draft pending and makes no reservation',t=>{
 const store=setup(t);const draft=store.db.prepare('SELECT id FROM drafts').get().id;
 assert.equal(reserveSend(store.db,'customer',draft,time+7*day),false);
 assert.equal(store.db.prepare('SELECT status FROM drafts').get().status,'draft');
 assert.equal(access(store.db,'customer',time).usedMessages,0);
 const period=access(store.db,'customer',time).periodId;
 for(let i=0;i<100;i++)store.db.prepare('INSERT INTO subscription_usage VALUES (?,?,?)').run('previous-'+i,period,time);
 assert.equal(reserveSend(store.db,'customer',draft,time),false);
 assert.equal(store.db.prepare('SELECT status FROM drafts').get().status,'draft');
});
test('one customer cannot spend another customer quota or claim another customer draft',t=>{
 const store=setup(t);startTrial(store.db,'other',time);
 assert.equal(reserveSend(store.db,'other',store.db.prepare('SELECT id FROM drafts').get().id,time),false);
 assert.equal(access(store.db,'other',time).usedMessages,0);
});

test('accounts beyond the current plan cap cannot send after downgrade or migration',t=>{
 const store=setup(t);
 store.db.prepare('INSERT INTO customer_accounts VALUES (?,?)').run('999','customer');
 store.db.prepare('INSERT INTO customer_rules VALUES (?,?,?,?,?,1)').run('extra','customer','999','гайд','Ответ');
 const payload={entry:[{id:'999',messaging:[{timestamp:time,sender:{id:'456'},recipient:{id:'999'},message:{mid:'extra-message',text:'гайд'}}]}]};
 store.receive(Buffer.from(JSON.stringify(payload)),payload);
 store.process([{id:'extra',accountId:'999',trigger:'message',keyword:'гайд',reply:'Ответ'}]);
 const draft=store.db.prepare("SELECT id FROM drafts WHERE account_id='999'").get().id;
 assert.equal(reserveSend(store.db,'customer',draft,time),false);
 assert.equal(access(store.db,'customer',time).usedMessages,0);
});

test('paid access keeps counting sends beyond the old message quota',t=>{
 const store=setup(t);
 applyVerifiedPayment(store.db,{customerId:'customer',paymentId:'provider:paid-no-quota',planId:'start',
  amount:59000,currency:'RUB',status:'succeeded'},time);
 const paidAt=time+7*day;
 const paid=access(store.db,'customer',paidAt);
 assert.equal(paid.limits.messages,null);
 const insert=store.db.prepare('INSERT INTO subscription_usage VALUES (?,?,?)');
 for(let index=0;index<1000;index++) insert.run('paid-previous-'+index,paid.periodId,paidAt);
 const draft=store.db.prepare('SELECT id FROM drafts').get().id;
 assert.equal(reserveSend(store.db,'customer',draft,paidAt),true);
 assert.equal(access(store.db,'customer',paidAt).usedMessages,1001);
 assert.equal(reserveSend(store.db,'customer',draft,paidAt),false);
});

test('a paid period grants the number of Instagram accounts selected in the invoice',t=>{
 const store=setup(t);
 applyVerifiedPayment(store.db,{customerId:'customer',paymentId:'provider:three',planId:'start_3',
  amount:79000,currency:'RUB',status:'succeeded'},time);
 assert.equal(access(store.db,'customer',time).limits.accounts,1);
 assert.equal(access(store.db,'customer',time+7*day).limits.accounts,3);
});
