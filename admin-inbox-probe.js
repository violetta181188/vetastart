const {adminOnly} = require('./admin-status');
const {unseal} = require('./instagram-auth');
const {matches} = require('./postgres-app/automation');

// Diagnostic for the owner's test only. No message content is returned, stored,
// enqueued or sent, and accounts owned by customers are outside this route.
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
      const token=unseal(row.token_cipher,env);
      const url=new URL(`https://graph.facebook.com/${env.META_GRAPH_API_VERSION}/${id}/conversations`);
      url.search=new URLSearchParams({platform:'instagram',limit:'10',
        fields:'id,messages.limit(5){message,created_time,from}'}).toString();
      const response=await fetchImpl(url.href,{headers:{Authorization:'Bearer '+token},
        redirect:'error',signal:AbortSignal.timeout(20000)});
      const body=await response.json();
      if(!response.ok||body?.error)return res.status(502).json({error:'meta_conversations_rejected',status:response.status,
        ...(Number.isSafeInteger(body?.error?.code)?{metaCode:body.error.code}:{}),
        ...(Number.isSafeInteger(body?.error?.error_subcode)?{metaSubcode:body.error.error_subcode}:{})});
      if(!Array.isArray(body?.data))return res.status(502).json({error:'invalid_conversation_response'});
      let scannedMessages=0,matchedRecentTestMessages=0,matchedExpectedSender=0;
      const current=now();let moreAvailable=!!body.paging?.next;
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
          if(message.from.username==='violettaproekti')matchedExpectedSender++;
        }
      }
      res.json({scannedConversations:conversations.length,scannedMessages,matchedRecentTestMessages,
        matchedExpectedSender,moreAvailable,queued:false,sent:false});
    }catch{res.status(502).json({error:'inbox_probe_unavailable'});}
  });
}
module.exports={installInboxProbe};
