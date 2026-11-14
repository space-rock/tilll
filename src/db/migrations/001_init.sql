CREATE TABLE invoices (
  id              TEXT PRIMARY KEY,           -- inv_<ulid>
  amount          TEXT NOT NULL,              -- base units of asset_id
  asset_id        TEXT NOT NULL,              -- the settlement asset when the invoice was made
  settlement_account TEXT NOT NULL,           -- the account that receives its payment: fixed when the invoice is made
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
  -- Snapshot of the payer's token at attempt time, so amounts can be displayed (and put in webhooks)
  -- without looking the token up in a list that may have changed.
  origin_symbol     TEXT,
  origin_decimals   INTEGER,
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
  -- awaiting_approval: asked for, not yet signed by the merchant's wallet. pending: approved, being sent to 1Click.
  -- submitted: 1Click has the intent. succeeded and failed end it.
  status           TEXT NOT NULL,
  status_json      TEXT,
  -- idempotency_key: the merchant's key for a refund request; unique per invoice, so a retry cannot pay twice.
  idempotency_key  TEXT,
  error            TEXT,                      -- why a refund failed or could not move on, for the merchant
  intent_deadline  TEXT,                      -- when the signed intent stops being usable; set once it is signed
  -- The intent payload the server prepared and checked, exactly as it was handed to the wallet.
  payload_json     TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE UNIQUE INDEX refunds_idempotency ON refunds (invoice_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

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

CREATE TABLE refund_ledger_daily (            -- enforces the daily refund limit
  day      TEXT NOT NULL,                     -- YYYY-MM-DD UTC
  asset_id TEXT NOT NULL,                     -- a day's total is in one asset's units, never mixed
  total    TEXT NOT NULL,
  PRIMARY KEY (day, asset_id)
);

-- Settings changed in the dashboard. A row here wins over the value in .env until it is reset.
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Who changed what, and when. Never holds a secret.
CREATE TABLE settings_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  key        TEXT NOT NULL,
  old_value  TEXT,
  new_value  TEXT,
  changed_at TEXT NOT NULL
);

-- Every settlement asset ever used, so an invoice made in an earlier one still shows its own symbol and decimals.
CREATE TABLE settlement_assets (
  asset_id TEXT PRIMARY KEY,
  symbol   TEXT NOT NULL,
  decimals INTEGER NOT NULL,
  chain    TEXT NOT NULL
);
