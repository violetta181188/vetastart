// Meta's token endpoints require credentials in query parameters. Never log the
// URL, fetch options, provider response or original exception from these calls.
async function tokenRequest(endpoint, params, fetchImpl = fetch) {
  const url = new URL(`https://graph.instagram.com/${endpoint}`);
  url.search = new URLSearchParams(params).toString();
  let response, body;
  try {
    response = await fetchImpl(url.href, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15000) });
    body = await response.json();
  } catch { throw new Error('Token service unavailable'); }
  if (!response.ok) {
    const error = new Error('Token service rejected request');
    error.reauthorizationRequired = response.status === 401 || body?.error?.code === 190;
    throw error;
  }
  if (typeof body?.access_token !== 'string' || !body.access_token ||
      !Number.isSafeInteger(body.expires_in) || body.expires_in <= 86400) {
    throw new Error('Invalid long-lived token response');
  }
  return { accessToken: body.access_token, expiresIn: Math.min(body.expires_in, 60 * 86400) };
}

function exchangeLongLived(shortToken, secret, fetchImpl) {
  return tokenRequest('access_token', { grant_type: 'ig_exchange_token', client_secret: secret, access_token: shortToken }, fetchImpl);
}

function renewLongLived(token, fetchImpl) {
  return tokenRequest('refresh_access_token', { grant_type: 'ig_refresh_token', access_token: token }, fetchImpl);
}

module.exports = { exchangeLongLived, renewLongLived };
