function createAccountLabels({getToken, env, fetchImpl, now}) {
  const cached = new Map();

  async function fetchUsername(accountId) {
    if (!/^\d+$/.test(accountId) || !/^v\d+\.\d+$/.test(env.META_GRAPH_API_VERSION || '')) return undefined;
    try {
      const token = await getToken(accountId);
      const host = env.INSTAGRAM_LOGIN_MODE === 'unified' ? 'graph.facebook.com' : 'graph.instagram.com';
      const response = await fetchImpl(`https://${host}/${env.META_GRAPH_API_VERSION}/${accountId}?fields=id,username`, {
        headers: {Authorization: 'Bearer ' + token},
        redirect: 'error',
        signal: AbortSignal.timeout(2500)
      });
      if (!response.ok) return undefined;
      const profile = await response.json();
      if (profile?.id === accountId && typeof profile.username === 'string' && /^[a-z0-9._]{1,30}$/i.test(profile.username)) {
        return profile.username;
      }
    } catch {
      // A profile lookup failure leaves the account selectable by ID.
    }
  }

  async function addUsername(account) {
    const id = account.account_id;
    let entry = cached.get(id);
    if (!entry || entry.expiresAt <= now()) {
      const previous = entry?.username;
      entry = {expiresAt: now() + 10000};
      entry.result = fetchUsername(id).then(username => {
        entry.username = username ?? previous;
        entry.expiresAt = now() + (username ? 300000 : 30000);
        return entry.username;
      });
      cached.delete(id);
      cached.set(id, entry);
      if (cached.size > 256) cached.delete(cached.keys().next().value);
    }
    const username = await entry.result;
    return username ? {...account, username} : account;
  }

  return accounts => Promise.all(accounts.map(addUsername));
}

module.exports = {createAccountLabels};
