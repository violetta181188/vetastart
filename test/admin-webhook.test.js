const {test} = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const {installAdminWebhook} = require('../admin-webhook');
const env = {VETASTART_ADMIN_TOKEN:'fixture-administrator-secret-over-32-characters',
  VETASTART_PUBLIC_ORIGIN:'https://app.example',META_APP_ID:'123',META_APP_SECRET:'private-secret',
  META_GRAPH_API_VERSION:'v27.0',INSTAGRAM_VERIFY_TOKEN:'private-verify'};
async function setup(t, fetchImpl) {
  const app = express();installAdminWebhook(app,{env,fetchImpl});
  const server = app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  return key => fetch(`http://127.0.0.1:${server.address().port}/api/admin/instagram/webhook`,
    {method:'POST',headers:{Authorization:'Bearer '+key}});
}
test('webhook management requires administrator token before contacting Meta',async t=>{
  const call=await setup(t,()=>assert.fail('unauthorized external request'));
  assert.equal((await call('wrong')).status,401);
});
test('webhook management preserves a different existing callback',async t=>{
  let calls=0;
  const call=await setup(t,async()=>{calls++;return Response.json({data:[{object:'instagram',active:true,callback_url:'https://other.example/webhook'}]});});
  assert.equal((await call(env.VETASTART_ADMIN_TOKEN)).status,409);assert.equal(calls,1);
});
test('webhook setup preserves fields and confirms configuration after updating',async t=>{
  let calls=0;
  const callback='https://app.example/webhooks/instagram';
  const call=await setup(t,async(url,options)=>{
    calls++;
    assert.equal(url,'https://graph.facebook.com/v27.0/123/subscriptions');
    assert.equal(options.headers.Authorization,'Bearer 123|private-secret');
    if(options.method==='POST'){
      assert.equal(options.body.get('verify_token'),'private-verify');
      assert.equal(options.body.get('callback_url'),callback);
      assert.equal(options.body.get('fields'),'comments,messages');
      return Response.json({success:true});
    }
    return Response.json({data:[{object:'instagram',active:true,callback_url:callback,
      fields:(calls===1?['comments']:['comments','messages']).map(name=>({name}))}]});
  });
  const result=await call(env.VETASTART_ADMIN_TOKEN);
  assert.equal(result.status,200);assert.deepEqual(await result.json(),{ready:true,changed:true});
  assert.equal(calls,3);
});
test('webhook setup is idempotent when the callback is ready',async t=>{
  const call=await setup(t,async(_url,options)=>{
    assert.equal(options.method,undefined);
    return Response.json({data:[{object:'instagram',active:true,callback_url:'https://app.example/webhooks/instagram',fields:[{name:'messages'}]}]});
  });
  const result=await call(env.VETASTART_ADMIN_TOKEN);
  assert.equal(result.status,200);assert.deepEqual(await result.json(),{ready:true,changed:false});
});
test('webhook failures never expose Meta response credentials',async t=>{
  const call=await setup(t,async()=>Response.json({error:{message:'private-secret private-verify'}},{status:400}));
  const result=await call(env.VETASTART_ADMIN_TOKEN);
  assert.equal(result.status,502);assert.doesNotMatch(await result.text(),/private/);
});
