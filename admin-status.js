const crypto = require('node:crypto');

// Read-only operational metadata. Tokens and message bodies never leave storage.
function installAdminStatus(app, {getStore, env}) {
  app.get('/api/admin/instagram/status', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const key = env.VETASTART_ADMIN_TOKEN;
    const supplied = req.get('Authorization') || '';
    const digest = value => crypto.createHash('sha256').update(value).digest();
    if (typeof key !== 'string' || key.length < 32 ||
        !crypto.timingSafeEqual(digest(supplied), digest('Bearer ' + key))) return res.sendStatus(401);
    try {
      const db = getStore().db;
      const connections = await db.prepare(`SELECT account_id,connection_status,token_mode,expires_at
        FROM instagram_connections ORDER BY account_id`).all();
      const deliveries = await db.prepare('SELECT count(*) AS n FROM deliveries').get();
      const events = await db.prepare('SELECT status,count(*) AS n FROM events GROUP BY status').all();
      return res.json({connections, deliveries: Number(deliveries.n), events,
        automationEnabled: env.VETASTART_AUTOMATION_ENABLED === 'true',
        sendingEnabled: env.VETASTART_SEND_ENABLED === 'true'});
    } catch {
      return res.sendStatus(503);
    }
  });
}
module.exports = {installAdminStatus};
