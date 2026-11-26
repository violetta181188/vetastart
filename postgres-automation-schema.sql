-- Isolated automation storage. Does not alter public.users/sessions/scenarios.
CREATE SCHEMA IF NOT EXISTS vetastart_automation;
CREATE TABLE IF NOT EXISTS vetastart_automation.deliveries (
  id TEXT PRIMARY KEY,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw_body TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS vetastart_automation.events (
  id UUID PRIMARY KEY,
  delivery_id TEXT NOT NULL REFERENCES vetastart_automation.deliveries(id),
  account_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('message','comment')),
  source_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  text TEXT NOT NULL,
  occurred_at BIGINT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(account_id,type,source_id)
);
CREATE INDEX IF NOT EXISTS events_pending_idx ON vetastart_automation.events(created_at,id) WHERE status='pending';
CREATE TABLE IF NOT EXISTS vetastart_automation.drafts (
  id UUID PRIMARY KEY,
  event_id UUID NOT NULL UNIQUE REFERENCES vetastart_automation.events(id),
  scenario_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
