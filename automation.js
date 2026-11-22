const { DatabaseSync } = require('node:sqlite');
const { mkdirSync, chmodSync } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function validateRules(rules) {
  if (!Array.isArray(rules)) throw new Error('Scenarios must be an array');
  const ids = new Set();
  for (const rule of rules) {
    if (!rule || typeof rule.id !== 'string' || !rule.id.trim() || ids.has(rule.id) ||
        typeof rule.accountId !== 'string' || !rule.accountId.trim() ||
        !['message', 'comment'].includes(rule.trigger) ||
        typeof rule.keyword !== 'string' || !rule.keyword.trim() ||
        typeof rule.reply !== 'string' || !rule.reply.trim() || rule.reply.length > 1000 ||
        (rule.enabled !== undefined && typeof rule.enabled !== 'boolean')) {
      throw new Error('Invalid scenario: unique id, accountId, trigger, keyword and reply required');
    }
    ids.add(rule.id);
  }
  return rules;
}

function normalize(text) {
  return text.normalize('NFKC').toLocaleLowerCase('ru').trim();
}

function matches(text, keyword) {
  const escaped = normalize(keyword).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}($|[^\\p{L}\\p{N}_])`, 'u').test(normalize(text));
}

function extractEvents(payload) {
  const events = [];
  for (const entry of payload.entry) {
    if (!entry || typeof entry.id !== 'string' || !entry.id) continue;
    for (const item of Array.isArray(entry.messaging) ? entry.messaging : []) {
      if (!item || item.message?.is_echo || item.sender?.id === entry.id ||
          item.recipient?.id !== entry.id || typeof item.sender?.id !== 'string' ||
          typeof item.message?.mid !== 'string' || !item.message.mid ||
          typeof item.message?.text !== 'string' || !item.message.text.trim()) continue;
      events.push({ accountId: entry.id, type: 'message', sourceId: item.message.mid,
        senderId: item.sender.id, text: item.message.text,
        occurredAt: Number.isSafeInteger(item.timestamp) ? item.timestamp : null });
    }
    for (const change of Array.isArray(entry.changes) ? entry.changes : []) {
      const value = change?.value;
      if (change?.field !== 'comments' || typeof value?.id !== 'string' || !value.id ||
          typeof value?.from?.id !== 'string' || value.from.id === entry.id ||
          typeof value.text !== 'string' || !value.text.trim()) continue;
      events.push({ accountId: entry.id, type: 'comment', sourceId: value.id,
        senderId: value.from.id, text: value.text });
    }
  }
  return events;
}

class AutomationStore {
  constructor(filename) {
    if (filename !== ':memory:') {
      mkdirSync(path.dirname(path.resolve(filename)), { recursive: true, mode: 0o700 });
    }
    this.db = new DatabaseSync(filename);
    if (filename !== ':memory:') chmodSync(filename, 0o600);
    this.db.exec(`
      PRAGMA journal_mode = DELETE;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS deliveries (
        id TEXT PRIMARY KEY, received_at TEXT NOT NULL, payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY, delivery_id TEXT NOT NULL,
        account_id TEXT NOT NULL, type TEXT NOT NULL, source_id TEXT NOT NULL,
        sender_id TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
        UNIQUE(account_id, type, source_id)
      );
      CREATE TABLE IF NOT EXISTS drafts (
        id TEXT PRIMARY KEY, event_id TEXT NOT NULL UNIQUE, scenario_id TEXT NOT NULL,
        account_id TEXT NOT NULL, recipient_id TEXT NOT NULL, text TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft', created_at TEXT NOT NULL
      );
    `);
    // Additive migrations preserve databases created before outbound delivery existed.
    const eventColumns = this.db.prepare('PRAGMA table_info(events)').all().map(c => c.name);
    if (!eventColumns.includes('occurred_at')) this.db.exec('ALTER TABLE events ADD COLUMN occurred_at INTEGER');
    const draftColumns = this.db.prepare('PRAGMA table_info(drafts)').all().map(c => c.name);
    for (const [name, type] of [['attempted_at', 'TEXT'], ['message_id', 'TEXT'], ['failure_code', 'TEXT']]) {
      if (!draftColumns.includes(name)) this.db.exec(`ALTER TABLE drafts ADD COLUMN ${name} ${type}`);
    }
  }

  receive(raw, payload) {
    const id = crypto.createHash('sha256').update(raw).digest('hex');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.db.prepare('INSERT OR IGNORE INTO deliveries VALUES (?, ?, ?)')
        .run(id, new Date().toISOString(), raw.toString('utf8'));
      if (result.changes) {
        const insert = this.db.prepare(`INSERT OR IGNORE INTO events
          (id, delivery_id, account_id, type, source_id, sender_id, text, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
        for (const event of extractEvents(payload)) {
          insert.run(crypto.randomUUID(), id, event.accountId, event.type, event.sourceId, event.senderId, event.text, event.occurredAt ?? null);
        }
      }
      this.db.exec('COMMIT');
      return { duplicate: result.changes === 0 };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  process(rules, limit = 100) {
    validateRules(rules);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const events = this.db.prepare("SELECT * FROM events WHERE status = 'pending' LIMIT ?").all(limit);
      let drafts = 0;
      for (const event of events) {
        const rule = rules.find(rule => rule.enabled !== false && rule.accountId === event.account_id &&
          rule.trigger === event.type && matches(event.text, rule.keyword));
        if (rule) {
          this.db.prepare(`INSERT INTO drafts
            (id, event_id, scenario_id, account_id, recipient_id, text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
            .run(crypto.randomUUID(), event.id, rule.id, event.account_id, event.sender_id, rule.reply, new Date().toISOString());
          drafts++;
        }
        this.db.prepare('UPDATE events SET status = ? WHERE id = ?').run(rule ? 'drafted' : 'unmatched', event.id);
      }
      this.db.exec('COMMIT');
      return { processed: events.length, drafts };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close() { this.db.close(); }
}

module.exports = { AutomationStore, extractEvents, matches, validateRules };
