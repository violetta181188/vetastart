const express = require("express");
const path = require("path");
const crypto = require("crypto");

const app = express();
app.disable("x-powered-by");

function equalSecret(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

app.get("/webhooks/instagram", (req, res) => {
  const token = process.env.INSTAGRAM_VERIFY_TOKEN;
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
  const secret = process.env.META_APP_SECRET;
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
  // Transport only: scenario execution and durable event storage are not yet implemented.
  // Do not log message bodies, access tokens, or personal identifiers.
  console.log("Instagram webhook received", { entries: event.entry.length });
  return res.status(200).send("EVENT_RECEIVED");
});

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
// Only serve the public landing page; keep server source and package files private.
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

const port = process.env.PORT || 10000;
if (require.main === module) {
  app.listen(port, "0.0.0.0", () => console.log(`VetaStart запущен на порту ${port}`));
}
module.exports = app;
