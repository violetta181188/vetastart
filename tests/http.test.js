'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

// These tests use the staging HTTP app, without live credentials or database.
delete process.env.DATABASE_URL;
delete process.env.INSTAGRAM_VERIFY_TOKEN;
delete process.env.META_APP_SECRET;
const {app} = require('../server');
let server, base;
test.before(async () => {
  server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  base = 'http://127.0.0.1:' + server.address().port;
});
test.after(async () => {
  if (server) await new Promise((resolve,reject) => server.close(error => error?reject(error):resolve()));
});
async function request(path,method='GET',body,headers={}) {
  return fetch(base+path,{method,headers,body});
}
test('health check has a stable machine-readable response', async () => {
  const r = await request('/healthz');
  assert.equal(r.status,200);
  assert.deepEqual(await r.json(),{status:'ok',service:'vetastart'});
  assert.equal(r.headers.get('x-content-type-options'),'nosniff');
  assert.equal(r.headers.get('x-frame-options'),'DENY');
});
test('private account API refuses use until PostgreSQL is configured',async()=>{
  const r=await request('/api/accounts');
  assert.equal(r.status,503);
  assert.match((await r.json()).error,/База данных/);
});
test('API rejects forged cross-origin requests on writes',async()=>{
  const r=await request('/api/auth/login','POST',JSON.stringify({email:'test@example.com',password:'xyz'}),
    {'content-type':'application/json','origin':'https://attacker.example'});
  assert.equal(r.status,403);
  assert.match((await r.json()).error,/источник/);
});
test('API rejects writes without source headers',async()=>{
  const r=await request('/api/auth/login','POST','{}',{'content-type':'application/json'});
  assert.equal(r.status,403);
});
test('Meta verification endpoint refuses token when unconfigured',async()=>{
  const r=await request('/webhooks/instagram?hub.mode=subscribe&hub.verify_token=x&hub.challenge=hello');
  assert.equal(r.status,503);
});
test('Meta verification challenge requires exact verification token',async()=>{
  process.env.INSTAGRAM_VERIFY_TOKEN='fixture-verification-token';
  try {
    const q='?hub.mode=subscribe&hub.verify_token=fixture-verification-token&hub.challenge=fixture-challenge';
    const ok=await request('/webhooks/instagram'+q);
    assert.equal(ok.status,200);
    assert.equal(await ok.text(),'fixture-challenge');
    const bad=await request('/webhooks/instagram?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=fixture-challenge');
    assert.equal(bad.status,403);
  }finally{delete process.env.INSTAGRAM_VERIFY_TOKEN;}
});
test('Meta event POST requires signed raw payload, then validates JSON shape',async()=>{
  process.env.META_APP_SECRET='fixture-only-app-secret';
  const path='/webhooks/instagram', payload=JSON.stringify({object:'instagram',entry:[{id:'12345'}]});
  const mac = 'sha256='+crypto.createHmac('sha256',process.env.META_APP_SECRET).update(payload).digest('hex');
  try {
    const unsigned=await request(path,'POST',payload,{'content-type':'application/json'});
    assert.equal(unsigned.status,403);
    const invalid=await request(path,'POST',payload,{'content-type':'application/json','x-hub-signature-256':'sha256=bad'});
    assert.equal(invalid.status,403);
    const verified=await request(path,'POST',payload,{'content-type':'application/json','x-hub-signature-256':mac});
    assert.equal(verified.status,200);
    assert.equal(await verified.text(),'EVENT_RECEIVED');
    const other='{"object":"other","entry":[]}';
    const otherMac='sha256='+crypto.createHmac('sha256',process.env.META_APP_SECRET).update(other).digest('hex');
    const wrongObject=await request(path,'POST',other,{'content-type':'application/json','x-hub-signature-256':otherMac});
    assert.equal(wrongObject.status,400);
  }finally{delete process.env.META_APP_SECRET;}
});
test('unknown paths show app but do not expose server script',async()=>{
  const r=await request('/does-not-exist');
  assert.equal(r.status,200);
  const body=await r.text();
  assert.match(body,/VetaStart/);
  assert.doesNotMatch(body,/const express = require/);
});
