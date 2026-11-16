-- Keep source discovery and runtime setup independent: either can finish or fail first.
ALTER TABLE project_repositories ADD COLUMN check_setup_state TEXT NOT NULL DEFAULT 'NOT_STARTED';
ALTER TABLE project_repositories ADD COLUMN check_setup_error TEXT;
ALTER TABLE project_repositories ADD COLUMN check_setup_updated_at TEXT;
ALTER TABLE project_repositories ADD COLUMN last_dispatch_at TEXT;
UPDATE project_repositories SET check_setup_state=CASE
  WHEN runner_enabled=1 THEN 'READY'
  WHEN setup_pr_url IS NOT NULL THEN 'AWAITING_MERGE'
  ELSE 'NOT_STARTED' END;
