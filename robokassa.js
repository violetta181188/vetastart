const crypto = require('node:crypto');
const { PLANS, applyVerifiedPayment } = require('./subscriptions');

function initializeBilling(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS robokassa_invoices (
    id INTEGER PRIMARY KEY AUTOINCREMENT, order_key TEXT NOT NULL UNIQUE,
    customer_id TEXT NOT NULL, plan_id TEXT NOT NULL, amount INTEGER NOT NULL,
    is_test INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL
  )`);
}

function config(env, isTest = env.ROBOKASSA_TEST_MODE !== 'false', { forResult = false } = {}) {
  if ((!forResult && env.ROBOKASSA_ENABLED !== 'true') || !env.ROBOKASSA_MERCHANT_LOGIN ||
      !['md5','sha256','sha512'].includes(env.ROBOKASSA_HASH_ALGORITHM)) throw new Error('Robokassa is not configured');
  if (!forResult && !isTest && env.ROBOKASSA_LIVE_ENABLED !== 'true') throw new Error('Live payments are disabled');
  const password1 = env[isTest ? 'ROBOKASSA_TEST_PASSWORD1' : 'ROBOKASSA_PASSWORD1'];
  const password2 = env[isTest ? 'ROBOKASSA_TEST_PASSWORD2' : 'ROBOKASSA_PASSWORD2'];
  if (!password1 || !password2) throw new Error('Robokassa passwords missing');
  return { isTest, login:env.ROBOKASSA_MERCHANT_LOGIN, algorithm:env.ROBOKASSA_HASH_ALGORITHM,password1,password2 };
}

function signature(parts, algorithm) { return crypto.createHash(algorithm).update(parts.join(':'),'utf8').digest('hex'); }
function rubles(amount) { return (amount / 100).toFixed(2); }
function kopeks(raw) {
  if(typeof raw!=='string' || !/^\d{1,8}(?:\.\d{1,6})?$/.test(raw)) throw new Error('Invalid amount');
  const [whole,fraction='']=raw.split('.');
  if(fraction.slice(2).replace(/0/g,'')) throw new Error('Fractional kopeks are not supported');
  return Number(whole)*100+Number((fraction+'00').slice(0,2));
}

function createCheckout(db, customerId, planId, env, now = Date.now()) {
  const settings=config(env);
  if(!Object.hasOwn(PLANS,planId) || !PLANS[planId].availableForCheckout) throw new Error('Invalid plan');
  if(!db.prepare('SELECT id FROM customers WHERE id=?').get(customerId)) throw new Error('Customer not found');
  initializeBilling(db);
  // Reuse a recent pending invoice to avoid multiple purchases from double clicks.
  let invoice=db.prepare(`SELECT * FROM robokassa_invoices WHERE customer_id=? AND plan_id=? AND is_test=?
    AND amount=? AND status='pending' AND created_at>? ORDER BY id DESC LIMIT 1`)
    .get(customerId,planId,Number(settings.isTest),PLANS[planId].price,now-900000);
  if(!invoice) {
    const result=db.prepare(`INSERT INTO robokassa_invoices
      (order_key,customer_id,plan_id,amount,is_test,created_at) VALUES (?,?,?,?,?,?)`)
      .run(crypto.randomUUID(),customerId,planId,PLANS[planId].price,Number(settings.isTest),now);
    invoice=db.prepare('SELECT * FROM robokassa_invoices WHERE id=?').get(result.lastInsertRowid);
  }
  if(invoice.id>2147483647) throw new Error('Invoice ID exceeds supported range');
  const outSum=rubles(invoice.amount);
  const signed=signature([settings.login,outSum,String(invoice.id),settings.password1,'Shp_order='+invoice.order_key],settings.algorithm);
  const url=new URL('https://auth.robokassa.ru/Merchant/Index.aspx');
  url.search=new URLSearchParams({MerchantLogin:settings.login,OutSum:outSum,InvId:String(invoice.id),
    Description:`VetaStart: ${PLANS[planId].title}, 30 дней, аккаунтов: ${PLANS[planId].accounts}`,SignatureValue:signed,Shp_order:invoice.order_key,
    ...(settings.isTest?{IsTest:'1'}:{}),Culture:'ru',Encoding:'utf-8'}).toString();
  return {invoiceId:invoice.id,isTest:settings.isTest,paymentUrl:url.href};
}

function acceptResult(db, fields, env, now = Date.now()) {
  initializeBilling(db);
  const {OutSum,InvId,SignatureValue,Shp_order}=fields || {};
  if(typeof InvId!=='string' || !/^[1-9]\d{0,9}$/.test(InvId) || typeof Shp_order!=='string' ||
      typeof SignatureValue!=='string' || typeof OutSum!=='string' ||
      Object.keys(fields).some(key=>key.startsWith('Shp_')&&key!=='Shp_order')) throw new Error('Invalid payment result');
  const invoice=db.prepare('SELECT * FROM robokassa_invoices WHERE id=?').get(Number(InvId));
  if(!invoice || invoice.order_key!==Shp_order || invoice.amount!==kopeks(OutSum)) throw new Error('Payment does not match invoice');
  // Stored invoice mode selects the passwords. Caller-supplied IsTest cannot
  // turn a sandbox receipt into a paid subscription.
  const settings=config(env,!!invoice.is_test,{forResult:true});
  const expected=signature([OutSum,InvId,settings.password2,'Shp_order='+Shp_order],settings.algorithm);
  if(!/^[a-f\d]+$/i.test(SignatureValue) || SignatureValue.length!==expected.length ||
      !crypto.timingSafeEqual(Buffer.from(SignatureValue.toLowerCase()),Buffer.from(expected))) throw new Error('Invalid result signature');
  if(invoice.is_test) {
    db.prepare("UPDATE robokassa_invoices SET status='test_paid' WHERE id=?").run(invoice.id);
  } else {
    applyVerifiedPayment(db,{customerId:invoice.customer_id,paymentId:'robokassa:'+invoice.order_key,
      planId:invoice.plan_id,amount:invoice.amount,currency:'RUB',status:'succeeded'},now);
    db.prepare("UPDATE robokassa_invoices SET status='paid' WHERE id=?").run(invoice.id);
  }
  return 'OK'+InvId;
}

function installRobokassa(app,{getStore,env,now=Date.now}) {
  const express=require('express');
  app.post('/webhooks/payments/robokassa',express.urlencoded({extended:false,limit:'8kb'}),(req,res)=>{
    if(Object.keys(req.query).length) return res.sendStatus(400);
    try {res.type('text/plain').send(acceptResult(getStore().db,req.body,env,now()));}
    catch {res.sendStatus(400);}
  });
  // Browser return only displays status guidance; it never grants access.
  app.get('/billing/return',(_req,res)=>{
    res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer'});
    res.type('html').send('<!doctype html><html lang="ru"><meta charset="utf-8"><title>Оплата — VetaStart</title><h1>Проверка оплаты</h1><p>Доступ обновится после подтверждения Робокассы. Тестовая оплата платный доступ не включает.</p><a href="/app">Вернуться в кабинет</a></html>');
  });
}

module.exports={initializeBilling,config,createCheckout,acceptResult,installRobokassa,kopeks};
