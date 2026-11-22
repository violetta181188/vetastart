const crypto = require('node:crypto');

// Read-only operational metadata. Tokens and message bodies never leave storage.
function adminOnly(env) {
  return (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const key = env.VETASTART_ADMIN_TOKEN;
    const supplied = req.get('Authorization') || '';
    const digest = value => crypto.createHash('sha256').update(value).digest();
    if (typeof key !== 'string' || key.length < 32 ||
        !crypto.timingSafeEqual(digest(supplied), digest('Bearer ' + key))) return res.sendStatus(401);
    next();
  };
}
function installAdminStatus(app, {getStore, env, fetchImpl = fetch, webhookTraffic}) {
  app.get('/api/admin/instagram/status', adminOnly(env), async (_req, res) => {
    try {
      const db = getStore().db;
      const connections = await db.prepare(`SELECT c.account_id,c.connection_status,c.token_mode,c.expires_at,
        CASE WHEN EXISTS (SELECT 1 FROM customer_accounts a WHERE a.account_id=c.account_id)
        THEN 1 ELSE 0 END AS customer_owned FROM instagram_connections c ORDER BY c.account_id`).all();
      const deliveries = await db.prepare('SELECT count(*) AS n FROM deliveries').get();
      const events = await db.prepare('SELECT status,count(*) AS n FROM events GROUP BY status').all();
      return res.json({connections, deliveries: Number(deliveries.n), events,
        ...(webhookTraffic?{webhookTraffic:{...webhookTraffic}}:{}),
        automationEnabled: env.VETASTART_AUTOMATION_ENABLED === 'true',
        sendingEnabled: env.VETASTART_SEND_ENABLED === 'true'});
    } catch {
      return res.sendStatus(503);
    }
  });
  app.get('/api/admin/instagram/diagnostics', adminOnly(env), async (_req,res) => {
    try {
      const db=getStore().db;
      const rows=await db.prepare(`SELECT account_id,token_cipher FROM instagram_connections
        WHERE connection_status='active' ORDER BY account_id LIMIT 10`).all();
      const connections=[];
      for(const row of rows){
        const item={accountId:row.account_id};
        const request=async(path,stage)=>{
          try{
            const token=require('./instagram-auth').unseal(row.token_cipher,env);
            const response=await fetchImpl(`https://graph.facebook.com/${env.META_GRAPH_API_VERSION}/${path}`,
              {headers:{Authorization:'Bearer '+token},redirect:'error',signal:AbortSignal.timeout(15000)});
            const body=await response.json();
            if(!response.ok||body?.error){
              item.errors||=[];item.errors.push({stage,status:response.status,
                ...(Number.isSafeInteger(body?.error?.code)?{metaCode:body.error.code}:{})});return null;
            }
            return body;
          }catch{item.errors||=[];item.errors.push({stage});return null;}
        };
        const profile=await request(row.account_id+'?fields=id,username','profile');
        if(typeof profile?.username==='string')item.username=profile.username;
        if(/^\d+$/.test(profile?.id||''))item.profileId=profile.id;
        const subscriptions=await request(row.account_id+'/subscribed_apps?fields=id,subscribed_fields','account-subscription');
        if(Array.isArray(subscriptions?.data)){
          item.subscriptionCount=subscriptions.data.length;
          item.subscriptions=subscriptions.data.filter(app=>/^\d+$/.test(String(app.id))).map(app=>({
            appId:String(app.id),fields:Array.isArray(app.subscribed_fields)?app.subscribed_fields.filter(field=>typeof field==='string'):null}));
          const own=item.subscriptions.find(app=>app.appId===env.META_APP_ID);
          item.messagesSubscribed=own ? own.fields?.includes('messages') ?? null : false;
        }
        try{
          const token=require('./instagram-auth').unseal(row.token_cipher,env);
          const url=new URL(`https://graph.facebook.com/${env.META_GRAPH_API_VERSION}/debug_token`);
          url.searchParams.set('input_token',token);
          const response=await fetchImpl(url.href,{headers:{Authorization:`Bearer ${env.META_APP_ID}|${env.META_APP_SECRET}`},
            redirect:'error',signal:AbortSignal.timeout(15000)});
          const body=await response.json();
          if(response.ok&&body?.data){
            const details=body.data;
            item.token={valid:details.is_valid===true,appMatches:String(details.app_id)===env.META_APP_ID,
              ...(/^[A-Z_]{1,32}$/.test(details.type||'')?{type:details.type}:{}),
              scopes:Array.isArray(details.scopes)?details.scopes.filter(scope=>typeof scope==='string'&&/^[a-z_]{1,80}$/.test(scope)):[]};
          }else{item.errors||=[];item.errors.push({stage:'inspect-token',status:response.status});}
        }catch{item.errors||=[];item.errors.push({stage:'inspect-token'});}
        connections.push(item);
      }
      res.json({connections});
    }catch{res.sendStatus(503);}
  });
  app.post('/api/admin/instagram/accounts/:id/subscribe',adminOnly(env),async(req,res)=>{
    try{
      if(!/^\d+$/.test(req.params.id))return res.sendStatus(400);
      const row=await getStore().db.prepare("SELECT token_cipher FROM instagram_connections WHERE account_id=? AND connection_status='active'").get(req.params.id);
      if(!row)return res.sendStatus(404);
      const token=require('./instagram-auth').unseal(row.token_cipher,env);
      const endpoint=`https://graph.facebook.com/${env.META_GRAPH_API_VERSION}/${req.params.id}/subscribed_apps`;
      const headers={Authorization:'Bearer '+token};
      const previous=await fetchImpl(endpoint+'?fields=id,subscribed_fields',{headers,redirect:'error',signal:AbortSignal.timeout(15000)});
      const previousBody=await previous.json();
      if(!previous.ok||!Array.isArray(previousBody?.data))return res.sendStatus(502);
      const own=previousBody.data.find(app=>String(app.id)===env.META_APP_ID);
      if(own&&!Array.isArray(own.subscribed_fields))return res.status(409).json({error:'existing_subscription_fields_unknown'});
      const fields=[...new Set([...(own?.subscribed_fields||[]).filter(field=>typeof field==='string'),'messages'])];
      const response=await fetchImpl(endpoint+'?'+new URLSearchParams({subscribed_fields:fields.join(',')}),{
        method:'POST',headers,
        redirect:'error',signal:AbortSignal.timeout(15000)});
      const body=await response.json();
      if(!response.ok||body.success!==true)return res.status(502).json({error:'account_subscription_rejected',
        ...(Number.isSafeInteger(body?.error?.code)?{metaCode:body.error.code}:{})});
      res.json({accepted:true});
    }catch{res.sendStatus(502);}
  });
}
module.exports = {installAdminStatus, adminOnly};
