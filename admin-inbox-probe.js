const {adminOnly} = require('./admin-status');
const {unseal} = require('./instagram-auth');
const {matches} = require('./postgres-app/automation');

// Candidates stay server-side. Public diagnostics expose aggregate counters only.
async function readTestInbox({id,token,version,fetchImpl=fetch,now=Date.now}) {
  const url=new URL(`https://graph.facebook.com/${version}/${id}/conversations`);
  url.search=new URLSearchParams({platform:'instagram',limit:'10',
    fields:'id,messages.limit(5){id,message,created_time,from}'}).toString();
  const response=await fetchImpl(url.href,{headers:{Authorization:'Bearer '+token},
    redirect:'error',signal:AbortSignal.timeout(20000)});
  const body=await response.json();
  if(!response.ok||body?.error){
    const error=new Error('Meta conversations rejected');
    error.diagnostic={error:'meta_conversations_rejected',status:response.status,
      ...(Number.isSafeInteger(body?.error?.code)?{metaCode:body.error.code}:{}),
      ...(Number.isSafeInteger(body?.error?.error_subcode)?{metaSubcode:body.error.error_subcode}:{})};
    throw error;
  }
  if(!Array.isArray(body?.data))throw new Error('Invalid conversation response');
  let scannedMessages=0,matchedRecentTestMessages=0,matchedExpectedSender=0;
  const current=now(),candidates=[];let moreAvailable=!!body.paging?.next;
  const conversations=body.data.slice(0,10);
  for(const conversation of conversations){
    if(conversation.messages?.paging?.next)moreAvailable=true;
    for(const message of (Array.isArray(conversation.messages?.data)?conversation.messages.data:[]).slice(0,5)){
      scannedMessages++;
      const time=typeof message.created_time==='string'?Date.parse(message.created_time):NaN;
      if(typeof message.from?.id!=='string'||message.from.id===id||!Number.isFinite(time)||
        current-time<0||current-time>=86400000||typeof message.message!=='string'||
        !matches(message.message,'VETASTART ТЕСТ'))continue;
      matchedRecentTestMessages++;
      if(message.from.username==='violettaproekti'){
        matchedExpectedSender++;
        if(typeof message.id==='string'&&message.id&&message.id.length<=1024&&/^\d+$/.test(message.from.id))
          candidates.push({id:message.id,senderId:message.from.id,text:message.message,
            occurredAt:time,senderUsername:message.from.username});
      }
    }
  }
  candidates.sort((a,b)=>b.occurredAt-a.occurredAt||a.id.localeCompare(b.id));
  return {summary:{scannedConversations:conversations.length,scannedMessages,matchedRecentTestMessages,
    matchedExpectedSender,moreAvailable,queued:false,sent:false},candidates};
}
function installInboxProbe(app, {getStore, env, fetchImpl = fetch, now = Date.now}) {
  app.get('/api/admin/instagram/accounts/:id/test-inbox', adminOnly(env), async(req,res)=>{
    try {
      const id=req.params.id;
      if(!/^\d+$/.test(id))return res.sendStatus(400);
      if(!/^v\d+\.\d+$/.test(env.META_GRAPH_API_VERSION||''))return res.sendStatus(503);
      const row=await getStore().db.prepare(`SELECT c.token_cipher,c.token_mode FROM instagram_connections c
        WHERE c.account_id=? AND c.connection_status='active'
        AND NOT EXISTS (SELECT 1 FROM customer_accounts a WHERE a.account_id=c.account_id)`).get(id);
      if(!row)return res.sendStatus(404);
      if(row.token_mode!=='unified')return res.sendStatus(409);
      const result=await readTestInbox({id,token:unseal(row.token_cipher,env),version:env.META_GRAPH_API_VERSION,fetchImpl,now});
      if(req.query.routing==='1'){
        const candidate=result.candidates[0];
        if(!candidate)result.summary.routing={checked:false,reason:'recent_test_not_found'};
        else try{
          const url=new URL(`https://graph.facebook.com/${env.META_GRAPH_API_VERSION}/${id}/thread_owner`);
          url.searchParams.set('recipient',candidate.senderId);
          const response=await fetchImpl(url.href,{headers:{Authorization:'Bearer '+unseal(row.token_cipher,env)},
            redirect:'error',signal:AbortSignal.timeout(15000)});
          const body=await response.json();
          const owner=body?.data?.[0]?.thread_owner?.app_id ?? body?.thread_owner?.app_id;
          if(response.ok&&!body?.error){
            result.summary.routing={checked:true,...(/^\d+$/.test(String(owner||''))?
              {ownerAppId:String(owner),appMatches:String(owner)===env.META_APP_ID}:{ownerReported:false})};
          }else result.summary.routing={checked:false,status:response.status,
            ...(Number.isSafeInteger(body?.error?.code)?{metaCode:body.error.code}:{}),
            ...(Number.isSafeInteger(body?.error?.error_subcode)?{metaSubcode:body.error.error_subcode}:{})};
        }catch{result.summary.routing={checked:false,reason:'routing_request_unavailable'};}
      }
      res.json(result.summary);
    }catch(error){res.status(502).json(error.diagnostic||{error:'inbox_probe_unavailable'});}
  });
}
module.exports={installInboxProbe,readTestInbox};
