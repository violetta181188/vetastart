const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { AutomationStore } = require("./automation");
const { installInstagramAuth } = require("./instagram-auth");
const { installCustomers } = require("./customers");
const { installRobokassa } = require("./robokassa");
const {inspectConfiguration,databaseReady}=require('./deployment-check');

function createApp({ store, env = process.env, fetchImpl = fetch, now = Date.now, sendMail } = {}) {
const app = express();
app.disable("x-powered-by");
let activeStore = store;
app.locals.close = () => activeStore?.close();
const getStore = () => activeStore ||= new AutomationStore(env.VETASTART_DB_PATH || path.join(__dirname, "data", "automation.sqlite"));
app.locals.getStore = getStore;
app.get('/health/live',(_req,res)=>res.set('Cache-Control','no-store').json({status:'running'}));
app.get('/health/ready',(_req,res)=>{
  res.set('Cache-Control','no-store');
  try{
    const report=inspectConfiguration(env,{profile:env.VETASTART_READINESS_PROFILE||'runtime'});
    if(!report.ok||!databaseReady(getStore()))return res.status(503).json({status:'unavailable'});
    res.set('Cache-Control','no-store').json({status:'ready',externalServicesVerified:false});
  }catch{res.status(503).json({status:'unavailable'});}
});
installCustomers(app, { getStore, env, now, sendMail });
installRobokassa(app, { getStore, env, now });
installInstagramAuth(app, { getStore, env, fetchImpl, now });

function equalSecret(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

app.get("/webhooks/instagram", (req, res) => {
  const token = env.INSTAGRAM_VERIFY_TOKEN;
  if (!token) return res.sendStatus(503);
  const mode = req.query["hub.mode"];
  const supplied = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode !== "subscribe" || typeof supplied !== "string" ||
      typeof challenge !== "string" || !challenge ||
      !equalSecret(supplied, token)) return res.sendStatus(403);
  return res.status(200).type("text/plain").send(challenge);
});

app.post("/webhooks/instagram", express.raw({ type: "application/json", limit: "1mb" }), (req, res) => {
  const secret = env.META_APP_SECRET;
  if (!secret) return res.sendStatus(503);
  if (!Buffer.isBuffer(req.body)) return res.sendStatus(415);
  const signature = req.get("x-hub-signature-256") || "";
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(req.body).digest("hex");
  if (!equalSecret(signature, expected)) return res.sendStatus(403);
  let event;
  try {
    event = JSON.parse(req.body.toString("utf8"));
  } catch {
    return res.sendStatus(400);
  }
  if (!event || event.object !== "instagram" || !Array.isArray(event.entry)) {
    return res.sendStatus(400);
  }
  try {
    activeStore ||= new AutomationStore(env.VETASTART_DB_PATH || path.join(__dirname, "data", "automation.sqlite"));
    // Acknowledge only after durable commit. No payloads or identifiers in logs.
    activeStore.receive(req.body, event);
  } catch {
    console.error("Instagram webhook persistence failed");
    return res.sendStatus(503);
  }
  return res.status(200).send("EVENT_RECEIVED");
});

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
// Only serve the public landing page; keep server source and package files private.
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

return app;
}

const app = createApp();
const port = process.env.PORT || 10000;
if (require.main === module) {
  const { runCycle, createRunner } = require('./automation-runner');
  const runner = process.env.VETASTART_AUTOMATION_ENABLED === 'true' ? createRunner({
    intervalMs: Number(process.env.VETASTART_AUTOMATION_INTERVAL_MS || 10000),
    cycle: () => runCycle(app.locals.getStore()), report: result => console.log(JSON.stringify(result)),
    onError: () => console.error('Automation cycle failed: check configuration and database')
  }) : null;
  const server = app.listen(port, "0.0.0.0", () => {
    console.log(`VetaStart запущен на порту ${port}`);
    runner?.start();
  });
  let closing = false;
  const shutdown = async () => {
    if (closing) return; closing = true;
    await runner?.stop();
    await new Promise(resolve => server.close(resolve));
    app.locals.close();
  };
  process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
}
module.exports = app;
module.exports.createApp = createApp;
