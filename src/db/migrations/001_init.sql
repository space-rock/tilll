CREATE TABLE invoices (
  id              TEXT PRIMARY KEY,           -- inv_<ulid>
  amount          TEXT NOT NULL,              -- base units of SETTLEMENT_ASSET_ID
  asset_id        TEXT NOT NULL,
  description     TEXT,
  metadata_json   TEXT,                       -- merchant's own data (order id etc.)
  status          TEXT NOT NULL,              -- open | paid | expired | canceled
  paid_attempt_id TEXT,
  refunded_amount TEXT NOT NULL DEFAULT '0',
  expires_at      TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE attempts (
  id                TEXT PRIMARY KEY,         -- att_<ulid>
  invoice_id        TEXT NOT NULL REFERENCES invoices(id),
  origin_asset      TEXT NOT NULL,            -- 1Click assetId chosen by payer
  origin_chain      TEXT NOT NULL,            -- blockchain from /v0/tokens
  refund_to         TEXT NOT NULL,            -- payer refund address on origin chain
  deposit_address   TEXT NOT NULL UNIQUE,
  deposit_memo      TEXT,
  amount_in         TEXT NOT NULL,            -- what we show the payer
  min_amount_in     TEXT NOT NULL,
  deadline          TEXT NOT NULL,
  quote_json        TEXT NOT NULL,            -- full quote response incl. signature
  oneclick_status   TEXT NOT NULL,            -- last raw status
  status            TEXT NOT NULL,            -- awaiting | confirming | underpaid | paid | refunded | failed | superseded
  status_json       TEXT,                     -- last full /v0/status response
  deposit_tx_hash   TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE TABLE refunds (
  id               TEXT PRIMARY KEY,          -- ref_<ulid>
  invoice_id       TEXT NOT NULL REFERENCES invoices(id),
  attempt_id       TEXT NOT NULL REFERENCES attempts(id),
  amount           TEXT NOT NULL,             -- base units of settlement asset
  reason           TEXT,                      -- merchant_request | overpayment_auto
  deposit_address  TEXT,                      -- from refund quote (links the status)
  quote_json       TEXT,
  intent_hash      TEXT,
  status           TEXT NOT NULL,             -- pending | submitted | succeeded | failed
  status_json      TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE TABLE webhook_deliveries (
  id            TEXT PRIMARY KEY,             -- evt_<ulid>
  event_type    TEXT NOT NULL,
  payload_json  TEXT NOT NULL,
  attempts      INTEGER NOT NULL DEFAULT 0,
  next_try_at   TEXT,
  delivered_at  TEXT,
  last_error    TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE refund_ledger_daily (            -- enforces REFUND_MAX_PER_DAY
  day    TEXT PRIMARY KEY,                    -- YYYY-MM-DD UTC
  total  TEXT NOT NULL
);
