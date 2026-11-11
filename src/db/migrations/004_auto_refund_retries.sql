-- Automatic refunds (PLAN section 8) are tried again after a failure that happened before anything was signed.
-- tries: how many times a try has been started. next_try_at: when the next try is due (also pushed forward while one runs,
-- so a crash in the middle leaves the refund due again after a few minutes).
ALTER TABLE refunds ADD COLUMN tries INTEGER NOT NULL DEFAULT 0;
ALTER TABLE refunds ADD COLUMN next_try_at TEXT;
-- Refunds recorded before this migration and not yet signed are due now.
UPDATE refunds SET next_try_at = created_at WHERE reason = 'overpayment_auto' AND status = 'pending' AND intent_deadline IS NULL;
