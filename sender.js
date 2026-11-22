const path = require('node:path');
const { AutomationStore } = require('./automation');
const { connectedToken, refreshConnections, unseal } = require('./instagram-auth');
const { loginMode } = require('./instagram-login');
const { reserveSend } = require('./subscriptions');

function configuration(env, store) {
  if (env.VETASTART_SEND_ENABLED !== 'true') throw new Error('Outbound sending is disabled');
  if (!/^\d+$/.test(env.INSTAGRAM_ACCOUNT_ID || '') ||
      !/^v\d+\.\d+$/.test(env.META_GRAPH_API_VERSION || '')) {
    throw new Error('Instagram account, access token and explicit Graph API version required');
  }
  const token = env.INSTAGRAM_ACCESS_TOKEN || (store && connectedToken(store, env.INSTAGRAM_ACCOUNT_ID, env));
  if (!token) throw new Error('Instagram token required');
  return { accountId: env.INSTAGRAM_ACCOUNT_ID, token,
    version: env.META_GRAPH_API_VERSION, host: loginMode(env) === 'unified' ? 'graph.facebook.com' : 'graph.instagram.com' };
}

// One bounded pass. Claim commits before networking: another sender cannot resend
// the same draft. Ambiguous outcomes remain held for reconciliation, never retried.
async function sendDrafts(store, { env = process.env, fetchImpl = fetch, now = Date.now, limit = 100 } = {}) {
  if (env.VETASTART_SEND_ENABLED === 'true' && !env.INSTAGRAM_ACCESS_TOKEN && /^\d+$/.test(env.INSTAGRAM_ACCOUNT_ID || '')) {
    await refreshConnections(store, { env, fetchImpl, now, accountId: env.INSTAGRAM_ACCOUNT_ID });
  }
  const config = configuration(env, store);
  const counts = { sent: 0, failed: 0, unknown: 0, blocked: 0 };
  const rows = store.db.prepare(`SELECT d.*, e.type, e.occurred_at FROM drafts d
    JOIN events e ON e.id = d.event_id WHERE d.status = 'draft' AND d.account_id = ? LIMIT ?`)
    .all(config.accountId, limit);
  for (const draft of rows) {
    // This transport supports replies to Direct messages only, within 24 hours.
    // Missing/invalid source timestamps and comment private replies need review.
    const age = now() - draft.occurred_at;
    const hasOwnership = store.db.prepare("SELECT name FROM sqlite_master WHERE name='customer_accounts'").get();
    const owner = hasOwnership && store.db.prepare('SELECT customer_id FROM customer_accounts WHERE account_id=?').get(draft.account_id);
    const activeRule = !owner || store.db.prepare(`SELECT 1 FROM customer_rules WHERE id=? AND customer_id=?
      AND account_id=? AND enabled=1`).get(draft.scenario_id, owner.customer_id, draft.account_id);
    const eligible = draft.type === 'message' && Number.isSafeInteger(draft.occurred_at) &&
      age >= 0 && age < 24 * 60 * 60 * 1000 && /^\d+$/.test(draft.recipient_id) && !!activeRule;
    const claimed = eligible && owner ? {changes:Number(reserveSend(store.db,owner.customer_id,draft.id,now()))}
      : store.db.prepare(`UPDATE drafts SET status = ?, attempted_at = ?, failure_code = ?
      WHERE id = ? AND status = 'draft'`).run(eligible ? 'sending' : 'blocked',
      new Date(now()).toISOString(), eligible ? null : 'ineligible_source', draft.id);
    if (!claimed.changes) continue;
    if (!eligible) { counts.blocked++; continue; }
    let status = 'unknown', messageId = null, failure = 'delivery_unconfirmed';
    let revoked = false;
    try {
      const response = await fetchImpl(`https://${config.host}/${config.version}/${config.accountId}/messages`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipient: { id: draft.recipient_id }, message: { text: draft.text } })
      });
      // Do not retain/log provider response bodies: they can contain personal data.
      const body = await response.json().catch(() => null);
      if (response.ok && typeof body?.message_id === 'string' && body.message_id) {
        status = 'sent'; messageId = body.message_id; failure = null;
      } else if (response.status >= 400 && response.status < 500) {
        status = 'failed'; failure = `http_${response.status}`;
        revoked = response.status === 401 || body?.error?.code === 190;
      }
    } catch {
      // Timeouts, connection loss, redirects and server errors can follow delivery.
      // Without a Meta idempotency guarantee, retrying can send duplicates.
    }
    store.db.prepare(`UPDATE drafts SET status = ?, message_id = ?, failure_code = ?
      WHERE id = ? AND status = 'sending'`).run(status, messageId, failure, draft.id);
    counts[status]++;
    if (revoked) {
      if (!env.INSTAGRAM_ACCESS_TOKEN) {
        const row = store.db.prepare('SELECT token_cipher FROM instagram_connections WHERE account_id=?').get(config.accountId);
        // A reauthorization completed during the request must not be invalidated.
        if (row && unseal(row.token_cipher, env) === config.token) {
          store.db.prepare(`UPDATE instagram_connections SET connection_status='reauthorization_required'
            WHERE account_id=? AND token_cipher=?`).run(config.accountId, row.token_cipher);
        }
      }
      break;
    }
  }
  return counts;
}

async function main() {
  if (process.env.VETASTART_SEND_ENABLED !== 'true') throw new Error('Outbound sending is disabled');
  const store = new AutomationStore(process.env.VETASTART_DB_PATH || path.join(__dirname, 'data', 'automation.sqlite'));
  try { console.log(JSON.stringify(await sendDrafts(store))); }
  finally { store.close(); }
}

if (require.main === module) main().catch(() => {
  console.error('Instagram sender stopped: check configuration, database and delivery statuses');
  process.exitCode = 1;
});

module.exports = { sendDrafts, configuration };
