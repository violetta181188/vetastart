const {adminOnly} = require('./admin-status');

function installAdminWebhook(app, {env, fetchImpl = fetch}) {
  app.post('/api/admin/instagram/webhook', adminOnly(env), async (_req, res) => {
    try {
      const origin = new URL(env.VETASTART_PUBLIC_ORIGIN);
      if (origin.protocol !== 'https:' || origin.username || origin.password ||
          !/^\d+$/.test(env.META_APP_ID || '') || !/^v\d+\.\d+$/.test(env.META_GRAPH_API_VERSION || '') ||
          !env.META_APP_SECRET || !env.INSTAGRAM_VERIFY_TOKEN) return res.sendStatus(503);
      const callback = origin.origin + '/webhooks/instagram';
      const endpoint = `https://graph.facebook.com/${env.META_GRAPH_API_VERSION}/${env.META_APP_ID}/subscriptions`;
      const headers = {Authorization: `Bearer ${env.META_APP_ID}|${env.META_APP_SECRET}`};
      const request = async options => {
        const response = await fetchImpl(endpoint, {...options, headers, redirect:'error', signal:AbortSignal.timeout(20000)});
        const body = await response.json();
        if (!response.ok || body?.error) throw new Error('Meta webhook configuration rejected');
        return body;
      };
      const before = await request();
      if (!Array.isArray(before.data)) return res.sendStatus(502);
      const current = before.data.find(item => item.object === 'instagram');
      // An existing different callback may serve another application workflow.
      if (current?.callback_url && current.callback_url !== callback) {
        return res.status(409).json({error:'existing_webhook_callback_differs'});
      }
      const fields = (current?.fields || []).map(item => item.name).filter(name => typeof name === 'string');
      let changed = false;
      if (current?.active !== true || !fields.includes('messages')) {
        const updated = await request({method:'POST', body:new URLSearchParams({object:'instagram',
          callback_url:callback, verify_token:env.INSTAGRAM_VERIFY_TOKEN,
          fields:[...new Set([...fields,'messages'])].join(',')})});
        if (updated.success !== true) return res.sendStatus(502);
        changed = true;
      }
      const after = changed ? await request() : before;
      const verified = after.data?.find(item => item.object === 'instagram');
      const ready = verified?.active === true && verified.callback_url === callback &&
        verified.fields?.some(item => item.name === 'messages');
      return res.status(ready ? 200 : 502).json({ready:!!ready, changed});
    } catch {
      return res.status(502).json({error:'meta_webhook_configuration_failed'});
    }
  });
}
module.exports = {installAdminWebhook};
