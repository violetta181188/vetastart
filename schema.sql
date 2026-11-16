-- Staging only. This schema can be applied more than once.
CREATE TABLE IF NOT EXISTS users (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name VARCHAR(80) NOT NULL,
  email VARCHAR(254) NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash CHAR(64) PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS instagram_accounts (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(50) NOT NULL,
  connection_status VARCHAR(20) NOT NULL DEFAULT 'not_connected'
    CHECK (connection_status IN ('not_connected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS instagram_accounts_user_idx ON instagram_accounts(user_id);
CREATE TABLE IF NOT EXISTS scenarios (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id BIGINT NOT NULL REFERENCES instagram_accounts(id) ON DELETE CASCADE,
  name VARCHAR(48) NOT NULL,
  keyword VARCHAR(40) NOT NULL,
  trigger_source VARCHAR(8) NOT NULL DEFAULT 'both'
    CHECK (trigger_source IN ('comment','dm','both')),
  enabled BOOLEAN NOT NULL DEFAULT false,
  follow_gate BOOLEAN NOT NULL DEFAULT false,
  messages JSONB NOT NULL DEFAULT '[]'::jsonb,
  choices JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT scenario_messages_array CHECK (jsonb_typeof(messages)='array' AND jsonb_array_length(messages) BETWEEN 1 AND 5),
  CONSTRAINT scenario_choices_array CHECK (jsonb_typeof(choices)='array' AND jsonb_array_length(choices)=3)
);
CREATE INDEX IF NOT EXISTS scenarios_account_idx ON scenarios(account_id);
CREATE UNIQUE INDEX IF NOT EXISTS scenario_keyword_enabled_uq
  ON scenarios (account_id, upper(btrim(keyword))) WHERE enabled = true;
