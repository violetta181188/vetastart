const {randomUUID} = require('node:crypto');

const maxPdfBytes = 2 * 1024 * 1024;
const maxRuleFileBytes = 12 * 1024 * 1024;
const filePath = id => '/automation-files/' + id;
const validFileId = id => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id);

const buttonTables = `
  CREATE TABLE IF NOT EXISTS rule_message_options (
    rule_id TEXT PRIMARY KEY REFERENCES customer_rules(id) ON DELETE CASCADE,
    buttons TEXT NOT NULL, require_follow INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS rule_message_files (
    id TEXT PRIMARY KEY, rule_id TEXT NOT NULL REFERENCES customer_rules(id) ON DELETE CASCADE,
    filename TEXT NOT NULL, content BYTEA NOT NULL, size_bytes INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS rule_message_files_rule_idx ON rule_message_files(rule_id);
`;

function parseButtons(value) {
  return value ? JSON.parse(value) : [];
}

function validateButtons(input, reply) {
  if (!Array.isArray(input) || input.length > 3 || (input.length && reply.trim().length > 640)) return null;
  const buttons = [];
  const files = [];
  for (const item of input) {
    const title = typeof item?.title === 'string' ? item.title.trim() : '';
    if (!title || title.length > 20) return null;

    if (item.type === 'url') {
      if (typeof item.url !== 'string' || item.url.length > 2000) return null;
      let url;
      try { url = new URL(item.url.trim()); } catch { return null; }
      if (url.protocol !== 'https:' || url.username || url.password || url.href.length > 2000) return null;
      buttons.push({type: 'url', title, url: url.href});
      continue;
    }

    if (item.type !== 'pdf') return null;
    if (item.data === undefined && validFileId(item.fileId)) {
      buttons.push({type: 'pdf', title, fileId: item.fileId});
      continue;
    }
    if (typeof item.data !== 'string' || item.data.length > 4 * Math.ceil(maxPdfBytes / 3) ||
        typeof item.filename !== 'string' || !/\.pdf$/i.test(item.filename)) return null;
    const content = Buffer.from(item.data, 'base64');
    if (content.length > maxPdfBytes || !content.subarray(0, 5).equals(Buffer.from('%PDF-')) ||
        content.toString('base64') !== item.data) return null;
    const filename = item.filename.replace(/[\\/\x00-\x1f\x7f]/g, '_');
    if (filename.length > 160) return null;
    const fileId = randomUUID();
    files.push({id: fileId, filename, content});
    buttons.push({type: 'pdf', title, fileId});
  }
  return {buttons, files};
}

function buttonFileError(payload, savedFiles) {
  const ids = new Set([...savedFiles, ...payload.files].map(file => file.id));
  if (payload.buttons.some(button => button.type === 'pdf' && !ids.has(button.fileId))) return 'invalid_buttons';
  const total = savedFiles.reduce((sum, file) => sum + file.size_bytes, 0) +
    payload.files.reduce((sum, file) => sum + file.content.length, 0);
  return total > maxRuleFileBytes ? 'button_storage_limit' : null;
}

function messageWithButtons(draft, publicOrigin) {
  const buttons = parseButtons(draft.message_buttons);
  if (!buttons.length) return {text: draft.text};
  return {attachment: {type: 'template', payload: {
    template_type: 'button',
    text: draft.text,
    buttons: buttons.map(button => ({
      type: 'web_url',
      title: button.title,
      url: button.type === 'pdf' ? new URL(filePath(button.fileId), publicOrigin).href : button.url
    }))
  }}};
}

async function directMessage(draft, config, origin, fetchImpl) {
  if (!draft.require_follow) return messageWithButtons(draft, origin);
  let follows;
  try {
    const response = await fetchImpl(
      `https://${config.host}/${config.version}/${draft.recipient_id}?fields=is_user_follow_business`, {
        method: 'GET',
        headers: {Authorization: `Bearer ${config.token}`},
        redirect: 'error',
        signal: AbortSignal.timeout(5000)
      }
    );
    if (response.ok) follows = (await response.json())?.is_user_follow_business;
  } catch {
    // A failed profile lookup cannot grant access to a gated reply.
  }
  if (follows === true) return messageWithButtons(draft, origin);
  if (follows === false) {
    return {text: 'Чтобы получить материал, подпишитесь на этот аккаунт в Instagram и отправьте кодовое слово ещё раз.'};
  }
  return {text: 'Сейчас не удалось проверить подписку. Попробуйте отправить кодовое слово чуть позже.'};
}

function sendPdf(res, file) {
  if (!file) return res.sendStatus(404);
  return res.set({
    'Cache-Control': 'private, no-store',
    'Content-Security-Policy': "sandbox; default-src 'none'",
    'X-Content-Type-Options': 'nosniff'
  }).attachment(file.filename).type('application/pdf').send(Buffer.from(file.content));
}

module.exports = {buttonTables, parseButtons, validateButtons, buttonFileError, validFileId, directMessage, sendPdf};
