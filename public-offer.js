const fs = require('node:fs');
const path = require('node:path');

const template = fs.readFileSync(path.join(__dirname, 'offer.html'), 'utf8');

function escapeHtml(value) {
  const entities = {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'};
  return value.replace(/[&<>"']/g, character => entities[character]);
}

function publicOffer(env) {
  const details = {
    name: env.VETASTART_OFFER_NAME,
    taxId: env.VETASTART_OFFER_TAX_ID,
    email: env.VETASTART_OFFER_EMAIL,
    phone: env.VETASTART_OFFER_PHONE,
    phoneLink: env.VETASTART_OFFER_PHONE?.replace(/[^+\d]/g, '')
  };
  const configured = Object.values(details).every(value => value?.trim());
  const html = configured && template.replace(/\{\{(\w+)\}\}/g, (_, key) => escapeHtml(details[key]));

  return (_req, res) => html ? res.type('html').send(html) : res.sendStatus(404);
}

module.exports = {publicOffer};
