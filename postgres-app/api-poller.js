const {unseal}=require('./instagram-auth');
async function initializePolling(db){
  await db.exec(`CREATE TABLE IF NOT EXISTS instagram_poll_state (
    account_id TEXT PRIMARY KEY,started_at INTEGER NOT NULL,next_poll_at INTEGER NOT NULL DEFAULT 0,
    lease_until INTEGER NOT NULL DEFAULT 0,last_success_at INTEGER,last_status TEXT NOT NULL DEFAULT 'new',
    last_ingested INTEGER NOT NULL DEFAULT 0,partial INTEGER NOT NULL DEFAULT 0
  )`);
}
async function pollOwnerInbox(store,{env=process.env,fetchImpl=fetch,now=Date.now}={}){
  const result={apiPolls:0,apiEvents:0,apiPollErrors:0,apiPartial:0};
  if(env.VETASTART_API_POLL_ENABLED!=='true')return result;
  const id=env.VETASTART_API_POLL_ACCOUNT_ID,interval=Number(env.VETASTART_API_POLL_INTERVAL_MS||60000);
  if(!/^\d+$/.test(id||'')||!/^v\d+\.\d+$/.test(env.META_GRAPH_API_VERSION||'')||
    !Number.isSafeInteger(interval)||interval<60000||interval>3600000)throw new Error('Invalid API polling configuration');
  const db=store.db,time=now();await initializePolling(db);
  const account=await db.prepare(`SELECT c.token_cipher,c.expires_at FROM instagram_connections c
    WHERE c.account_id=? AND c.connection_status='active' AND c.token_mode='unified'
    AND NOT EXISTS (SELECT 1 FROM customer_accounts a WHERE a.account_id=c.account_id)
    AND EXISTS (SELECT 1 FROM operator_rules r WHERE r.account_id=c.account_id AND r.enabled=1)`).get(id);
  if(!account){await db.prepare("UPDATE instagram_poll_state SET last_status='paused' WHERE account_id=? AND lease_until<=?").run(id,time);return result;}
  if(account.expires_at!==0&&account.expires_at<=time)return result;
  const state=await db.transaction(async()=>{
    await db.prepare('INSERT INTO instagram_poll_state (account_id,started_at) VALUES (?,?) ON CONFLICT(account_id) DO NOTHING')
      .run(id,Math.floor(time/1000)*1000);
    return db.prepare(`UPDATE instagram_poll_state SET started_at=CASE WHEN last_status='paused' THEN ? ELSE started_at END,
      lease_until=?,next_poll_at=?,last_status='running' WHERE account_id=? AND lease_until<=? AND next_poll_at<=?
      RETURNING started_at`).get(Math.floor(time/1000)*1000,time+45000,time+interval,id,time,time);
  });
  if(!state)return result;
  result.apiPolls=1;
  try{
    const url=new URL(`https://graph.facebook.com/${env.META_GRAPH_API_VERSION}/${id}/conversations`);
    url.search=new URLSearchParams({platform:'instagram',limit:'25',fields:'id,messages.limit(20){id,message,created_time,from}'}).toString();
    const response=await fetchImpl(url.href,{headers:{Authorization:'Bearer '+unseal(account.token_cipher,env)},
      redirect:'error',signal:AbortSignal.timeout(20000)});
    const body=await response.json();
    if(!response.ok||body?.error){
      if(body?.error?.code===190||response.status===401)await db.prepare(`UPDATE instagram_connections
        SET connection_status='reauthorization_required' WHERE account_id=? AND token_cipher=?`).run(id,account.token_cipher);
      const throttled=response.status===429||[4,17,32,613].includes(body?.error?.code);
      await db.prepare(`UPDATE instagram_poll_state SET lease_until=0,last_status=?,next_poll_at=? WHERE account_id=? AND lease_until=?`)
        .run(throttled?'rate_limited':'meta_rejected',time+(throttled?Math.max(interval,300000):interval),id,time+45000);
      result.apiPollErrors=1;return result;
    }
    if(!Array.isArray(body?.data))throw new Error('Invalid conversations response');
    let partial=!!body.paging?.next||body.data.length>25;
    const messages=new Map();
    for(const conversation of body.data.slice(0,25)){
      if(conversation.messages?.paging?.next)partial=true;
      const entries=Array.isArray(conversation.messages?.data)?conversation.messages.data:[];
      if(entries.length>20)partial=true;
      for(const message of entries.slice(0,20)){
        const occurredAt=typeof message.created_time==='string'?Date.parse(message.created_time):NaN;
        if(typeof message.id!=='string'||!message.id||message.id.length>1024||
          typeof message.from?.id!=='string'||!/^\d+$/.test(message.from.id)||message.from.id===id||
          typeof message.message!=='string'||!message.message.trim()||message.message.length>10000||
          !Number.isFinite(occurredAt)||occurredAt<state.started_at||occurredAt>time)continue;
        messages.set(message.id,{timestamp:occurredAt,sender:{id:message.from.id},recipient:{id},
          message:{mid:message.id,text:message.message}});
      }
    }
    const ingested=await db.transaction(async()=>{
      const current=await db.prepare(`SELECT 1 FROM instagram_connections c WHERE c.account_id=? AND c.token_cipher=?
        AND c.connection_status='active' AND NOT EXISTS (SELECT 1 FROM customer_accounts a WHERE a.account_id=c.account_id)
        AND EXISTS (SELECT 1 FROM instagram_poll_state p WHERE p.account_id=c.account_id AND p.lease_until=?)`).get(id,account.token_cipher,time+45000);
      if(!current)throw new Error('Connection changed during polling');
      let incoming=[...messages.values()];
      if(incoming.length){
        const existing=await db.prepare(`SELECT source_id FROM events WHERE account_id=? AND type='message'
          AND source_id IN (${incoming.map(()=>'?').join(',')})`).all(id,...incoming.map(item=>item.message.mid));
        const seen=new Set(existing.map(item=>item.source_id));incoming=incoming.filter(item=>!seen.has(item.message.mid));
      }
      if(incoming.length){
        const payload={object:'instagram',ingestion_source:'owner_api_poll',entry:[{id,messaging:incoming}]};
        await store.receive(Buffer.from(JSON.stringify(payload)),payload);
      }
      await db.prepare(`UPDATE instagram_poll_state SET lease_until=0,last_success_at=?,last_status=?,last_ingested=?,partial=?
        WHERE account_id=? AND lease_until=?`).run(time,partial?'partial':'ok',incoming.length,Number(partial),id,time+45000);
      return incoming.length;
    });
    result.apiEvents=ingested;
    result.apiPartial=Number(partial);
  }catch{
    result.apiPollErrors=1;
    await db.prepare("UPDATE instagram_poll_state SET lease_until=0,last_status='poll_failed' WHERE account_id=? AND lease_until=?")
      .run(id,time+45000);
  }
  return result;
}
module.exports={initializePolling,pollOwnerInbox};
