// Contract: Meta documentation supplied by the account owner, Unified Login
// Authentication and access tokens (v27.0). No legacy Instagram token exchange.
async function connectUnified(env, code, fetchImpl = fetch, now = Date.now) {
  if (!/^\d+$/.test(env.META_APP_ID || '') || !env.META_APP_SECRET ||
      !/^\d+$/.test(env.META_CLIENT_BUSINESS_ID || '')) throw new Error('Meta business configuration required');
  const version = env.META_GRAPH_API_VERSION;
  if (!/^v\d+\.\d+$/.test(version || '')) throw new Error('Graph version required');
  const issuedAt = now();
  const request = async (url, options = {}) => {
    let response;
    try { response = await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(15000) }); }
    catch { throw new Error('Meta connection failed'); }
    if (!response.ok) throw new Error('Meta request rejected');
    try { return await response.json(); } catch { throw new Error('Invalid Meta response'); }
  };
  const url = new URL(`https://graph.facebook.com/${version}/oauth/access_token`);
  url.search = new URLSearchParams({ client_id: env.META_APP_ID, client_secret: env.META_APP_SECRET, code }).toString();
  const token = await request(url.href);
  if (typeof token.access_token !== 'string' || !token.access_token) throw new Error('Token missing');
  let expiresAt;
  if (Number.isSafeInteger(token.expires_in) && token.expires_in > 0) {
    expiresAt = issuedAt + token.expires_in * 1000;
    if (!Number.isSafeInteger(expiresAt)) throw new Error('Invalid token expiry');
  } else if ((token.expires_in === undefined || token.expires_in === 0) && env.META_SUAT_NON_EXPIRING === 'true') {
    expiresAt = 0; // Only explicitly confirmed non-expiring Meta configuration.
  } else { throw new Error('Confirm token expiration in Meta configuration'); }
  const assets = await request(`https://graph.facebook.com/${version}/me/assigned_instagram_accounts`, {
    headers: { Authorization: `Bearer ${token.access_token}` }
  });
  if (!Array.isArray(assets.data)) throw new Error('Instagram assets missing');
  const valid = assets.data.filter(a => typeof a?.id === 'string' && /^\d+$/.test(a.id));
  const account = env.INSTAGRAM_ACCOUNT_ID
    ? valid.find(a => a.id === env.INSTAGRAM_ACCOUNT_ID)
    : (valid.length === 1 && !assets.paging?.next ? valid[0] : null);
  if (!account) throw new Error('Select an assigned Instagram account explicitly');
  const subscribed=await request(`https://graph.facebook.com/${version}/${account.id}/subscribed_apps`,{
    method:'POST',headers:{Authorization:`Bearer ${token.access_token}`},
    body:new URLSearchParams({subscribed_fields:'messages'})
  });
  if(subscribed.success!==true)throw new Error('Instagram message subscription was not confirmed');
  return { accessToken: token.access_token, expiresAt, issuedAt, accountId: account.id,
    businessId: env.META_CLIENT_BUSINESS_ID, configId: env.INSTAGRAM_CONFIG_ID };
}

module.exports = { connectUnified };
