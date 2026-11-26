function outboundScope(env) {
  const accountId = env.VETASTART_SEND_ACCOUNT_ID;
  const configuredSince = env.VETASTART_SEND_SINCE_MS;
  if (!accountId && !configuredSince) return null;
  const since = Number(configuredSince);
  if (!/^\d+$/.test(accountId || '') || !/^\d+$/.test(configuredSince || '') || !Number.isSafeInteger(since) || since <= 0) {
    throw new Error('Scoped sending requires a numeric Instagram account ID and a positive timestamp');
  }
  return {accountId, since};
}

module.exports = {outboundScope};
