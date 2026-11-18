-- Recovery creates a new execution with explicit checkpoint provenance.
-- Reused steps have no new attempt or fabricated execution duration.
ALTER TABLE runs ADD COLUMN recovery_mode TEXT CHECK (recovery_mode IN ('restart', 'resume'));
ALTER TABLE runs ADD COLUMN effect_scope_id TEXT;
ALTER TABLE execution_steps ADD COLUMN reused_from_run_id TEXT;
