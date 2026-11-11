-- Snapshot of the payer's token at attempt time, so amounts can be displayed (and put in webhooks)
-- without looking the token up in a list that may have changed. Nullable: rows are written together.
ALTER TABLE attempts ADD COLUMN origin_symbol TEXT;
ALTER TABLE attempts ADD COLUMN origin_decimals INTEGER;
