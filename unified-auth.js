// Contract: Meta documentation supplied by the account owner, Unified Login
// Authentication and access tokens (v27.0). No legacy Instagram token exchange.
async function connectUnified(env, code, fetchImpl = fetch, now = Date.now) {
  if (!/^\d+$/.test(env.META_APP_ID || '') || !env.META_APP_SECRET ||
      !/^\d+$/.test(env.META_CLIENT_BUSINESS_ID || '')) throw new Error('Meta business configuration required');
  const version = env.META_GRAPH_API_VERSION;
  if (!/^v\d+\.\d+$/.test(version || '')) throw new Error('Graph version required');
  // Use the same URL normalization as authConfig/authorizationUrl. Meta binds
  // the one-time code to this URI and rejects an omitted or different URI.
  const redirect = new URL(env.INSTAGRAM_REDIRECT_URI);
  if (redirect.protocol !== 'https:' || redirect.username || redirect.password ||
      redirect.search || redirect.hash || redirect.pathname !== '/auth/instagram/callback') {
    throw new Error('Valid Meta redirect URI required');
  }
  const issuedAt = now();
  const failure = (message, stage, status, metaCode, metaSubcode) => {
    const error = new Error(message);
    error.oauthDiagnostic = {stage, ...Object.fromEntries(Object.entries({status, metaCode, metaSubcode})
      .filter(([, value]) => Number.isSafeInteger(value)))};
    return error;
  };
  const request = async (url, options = {}, stage = 'unknown') => {
    let response;
    try { response = await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(15000) }); }
    catch { throw failure('Meta connection failed', stage); }
    let body;
    try { body = await response.json(); } catch { throw failure('Invalid Meta response', stage, response.status); }
    if (!response.ok || body?.error) throw failure('Meta request rejected', stage, response.status, body?.error?.code, body?.error?.error_subcode);
    return body;
  };
  const url = new URL(`https://graph.facebook.com/${version}/oauth/access_token`);
  url.search = new URLSearchParams({ client_id: env.META_APP_ID, client_secret: env.META_APP_SECRET,
    code, redirect_uri: redirect.href }).toString();
  const token = await request(url.href, {}, 'exchange');
  if (typeof token.access_token !== 'string' || !token.access_token) throw failure('Token missing', 'exchange');
  let expiresAt;
  if (Number.isSafeInteger(token.expires_in) && token.expires_in > 0) {
    expiresAt = issuedAt + token.expires_in * 1000;
    if (!Number.isSafeInteger(expiresAt)) throw new Error('Invalid token expiry');
  } else if ((token.expires_in === undefined || token.expires_in === 0) && env.META_SUAT_NON_EXPIRING === 'true') {
    expiresAt = 0; // Only explicitly confirmed non-expiring Meta configuration.
  } else if (token.expires_in === undefined || token.expires_in === 0) {
    // SUAT exchanges can omit expiry. Verify it with Meta rather than treating
    // a missing field as proof of a token that never expires.
    const debug = new URL(`https://graph.facebook.com/${version}/debug_token`);
    debug.searchParams.set('input_token', token.access_token);
    const inspected = await request(debug.href, {
      headers: {Authorization: `Bearer ${env.META_APP_ID}|${env.META_APP_SECRET}`}
    }, 'inspect-expiry');
    const details = inspected?.data;
    if (details?.is_valid !== true || String(details.app_id) !== env.META_APP_ID ||
        !Number.isSafeInteger(details.expires_at) || details.expires_at < 0 ||
        (details.expires_at > 0 && details.expires_at * 1000 <= issuedAt)) {
      throw failure('Confirm token expiration in Meta configuration', 'inspect-expiry');
    }
    expiresAt = details.expires_at * 1000;
    if (!Number.isSafeInteger(expiresAt)) throw failure('Invalid token expiry', 'inspect-expiry');
    if (Number.isSafeInteger(details.data_access_expires_at) && details.data_access_expires_at > 0) {
      const accessExpiry = details.data_access_expires_at * 1000;
      if (!Number.isSafeInteger(accessExpiry) || accessExpiry <= issuedAt) throw failure('Data access expired', 'inspect-expiry');
      expiresAt = expiresAt === 0 ? accessExpiry : Math.min(expiresAt, accessExpiry);
    }
  } else { throw failure('Invalid token expiry', 'exchange'); }
  const assets = await request(`https://graph.facebook.com/${version}/me/assigned_instagram_accounts`, {
    headers: { Authorization: `Bearer ${token.access_token}` }
  }, 'assigned-accounts');
  if (!Array.isArray(assets.data)) throw failure('Instagram assets missing', 'assigned-accounts');
  const valid = assets.data.filter(a => typeof a?.id === 'string' && /^\d+$/.test(a.id));
  const account = env.INSTAGRAM_ACCOUNT_ID
    ? valid.find(a => a.id === env.INSTAGRAM_ACCOUNT_ID)
    : (valid.length === 1 && !assets.paging?.next ? valid[0] : null);
  if (!account) throw failure('Select an assigned Instagram account explicitly', 'select-account');
  const subscribed=await request(`https://graph.facebook.com/${version}/${account.id}/subscribed_apps`,{
    method:'POST',headers:{Authorization:`Bearer ${token.access_token}`},
    body:new URLSearchParams({subscribed_fields:'messages'})
  }, 'subscribe-messages');
  if(subscribed.success!==true)throw failure('Instagram message subscription was not confirmed', 'subscribe-messages');
  return { accessToken: token.access_token, expiresAt, issuedAt, accountId: account.id,
    businessId: env.META_CLIENT_BUSINESS_ID, configId: env.INSTAGRAM_CONFIG_ID };
}

module.exports = { connectUnified };
