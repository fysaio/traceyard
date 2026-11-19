ALTER TABLE investigation_verifications ADD COLUMN baseline_request_id TEXT;
ALTER TABLE investigation_verifications ADD COLUMN comparison_incomplete INTEGER NOT NULL DEFAULT 0;
