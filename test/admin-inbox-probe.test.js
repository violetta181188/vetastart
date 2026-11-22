const {test}=require('node:test');const assert=require('node:assert/strict');
const express=require('express');const {seal}=require('../instagram-auth');
const {installInboxProbe}=require('../admin-inbox-probe');
const env={VETASTART_ADMIN_TOKEN:'fixture-administrator-secret-over-32-characters',
  META_APP_ID:'123',META_GRAPH_API_VERSION:'v27.0',VETASTART_TOKEN_KEY:Buffer.alloc(32,7).toString('base64')};
const time=Date.parse('2026-11-22T10:00:00Z');
async function setup(t,fetchImpl,{available=true}={}){
  let reads=0;const db={prepare(sql){assert.match(sql,/NOT EXISTS.*customer_accounts/s);return {get(id){
    reads++;assert.equal(id,'789');return available?{token_mode:'unified',token_cipher:seal('private-suat',env)}:null;
  }};}};
  const app=express();installInboxProbe(app,{getStore:()=>({db}),env,fetchImpl,now:()=>time});
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  t.after(()=>new Promise(r=>server.close(r)));
  return {reads:()=>reads,call:(key=env.VETASTART_ADMIN_TOKEN,id='789',query='')=>fetch(
    `http://127.0.0.1:${server.address().port}/api/admin/instagram/accounts/${id}/test-inbox${query}`,
    {headers:{Authorization:'Bearer '+key}})};
}
test('inbox probe rejects unauthenticated, malformed and unavailable accounts before external calls',async t=>{
  const probe=await setup(t,()=>assert.fail('must not contact Meta'),{available:false});
  assert.equal((await probe.call('wrong')).status,401);assert.equal(probe.reads(),0);
  assert.equal((await probe.call(env.VETASTART_ADMIN_TOKEN,'invalid')).status,400);assert.equal(probe.reads(),0);
  assert.equal((await probe.call()).status,404);
});
test('optional routing check reports only the owner application and never requests a transfer',async t=>{
  const probe=await setup(t,async(endpoint,options)=>{
    assert.equal(options.method,undefined);
    const url=new URL(endpoint);
    if(url.pathname.endsWith('/thread_owner')){
      assert.equal(url.searchParams.get('recipient'),'321');
      return Response.json({data:[{recipient:{id:'321'},thread_owner:{app_id:'456'}}]});
    }
    return Response.json({data:[{messages:{data:[{id:'private-message',message:'VETASTART ТЕСТ',
      created_time:'2026-11-22T09:00:00Z',from:{id:'321',username:'violettaproekti'}}]}}]});
  });
  const result=await(await probe.call(env.VETASTART_ADMIN_TOKEN,'789','?routing=1')).json();
  assert.deepEqual(result.routing,{checked:true,ownerAppId:'456',appMatches:false});
  assert.doesNotMatch(JSON.stringify(result),/321|private-message/);
});
test('inbox probe finds only recent incoming test messages without returning conversation content',async t=>{
  const msg=(message,from,created_time='2026-11-22T09:00:00Z')=>({message,from,created_time});
  const sender={id:'321',username:'violettaproekti'};
  const probe=await setup(t,async(endpoint,options)=>{
    const url=new URL(endpoint);assert.equal(url.pathname,'/v27.0/789/conversations');
    assert.equal(url.searchParams.get('platform'),'instagram');assert.equal(url.searchParams.get('limit'),'10');
    assert.equal(options.method,undefined);assert.equal(options.headers.Authorization,'Bearer private-suat');
    return Response.json({data:[{id:'private-conversation',messages:{data:[
      msg('VETASTART ТЕСТ',sender),msg('private-unrelated-text',sender),
      msg('VETASTART ТЕСТ',{id:'789'}),msg('VETASTART ТЕСТ',sender,'2026-11-20T09:00:00Z'),
      msg('VETASTART ТЕСТ',sender,'2026-11-23T09:00:00Z')],paging:{next:'https://unfollowed.example'}}}]});
  });
  const response=await probe.call();assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
  const result=await response.json();assert.deepEqual(result,{scannedConversations:1,scannedMessages:5,
    matchedRecentTestMessages:1,matchedExpectedSender:1,moreAvailable:true,queued:false,sent:false});
  assert.doesNotMatch(JSON.stringify(result),/private|321|789|violettaproekti/);
});
test('inbox probe preserves numeric Meta rejection evidence without exposing provider errors',async t=>{
  const probe=await setup(t,async()=>Response.json({error:{code:10,error_subcode:123,message:'private-suat private-user-text'}},{status:400}));
  const response=await probe.call();assert.equal(response.status,502);
  assert.deepEqual(await response.json(),{error:'meta_conversations_rejected',status:400,metaCode:10,metaSubcode:123});
});
