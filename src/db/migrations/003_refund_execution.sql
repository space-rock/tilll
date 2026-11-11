-- Refund execution (PLAN section 9).
-- idempotency_key: the merchant's key for a refund request; unique per invoice, so a retry cannot pay twice.
ALTER TABLE refunds ADD COLUMN idempotency_key TEXT;
-- Why a refund failed, for the merchant.
ALTER TABLE refunds ADD COLUMN error TEXT;
-- When the signed intent stops being usable. Set once an intent is signed; a refund without it never had money moved.
ALTER TABLE refunds ADD COLUMN intent_deadline TEXT;
CREATE UNIQUE INDEX refunds_idempotency ON refunds (invoice_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
