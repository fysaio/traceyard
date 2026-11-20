-- Drops tables used only by the retired workflow run engine, model gateway,
-- experiments, approvals, automations, saved workflows and audit log (#43).
-- No remaining table references them. Child tables are dropped before parents.
DROP TABLE IF EXISTS approval_tasks;
DROP TABLE IF EXISTS audit_events;
DROP TABLE IF EXISTS execution_dispatches;
DROP TABLE IF EXISTS execution_events;
DROP TABLE IF EXISTS execution_leases;
DROP TABLE IF EXISTS experiment_runs;
DROP TABLE IF EXISTS http_connections;
DROP TABLE IF EXISTS http_requests;
DROP TABLE IF EXISTS idempotency_records;
DROP TABLE IF EXISTS model_requests;
DROP TABLE IF EXISTS model_routes;
DROP TABLE IF EXISTS organization_memberships;
DROP TABLE IF EXISTS provider_credentials;
DROP TABLE IF EXISTS quota_counters;
DROP TABLE IF EXISTS quota_reservation_buckets;
DROP TABLE IF EXISTS run_http_connections;
DROP TABLE IF EXISTS run_model_routes;
DROP TABLE IF EXISTS saved_workflows;
DROP TABLE IF EXISTS scheduled_dispatches;
DROP TABLE IF EXISTS step_attempts;
DROP TABLE IF EXISTS system_flags;
DROP TABLE IF EXISTS webhook_deliveries;
DROP TABLE IF EXISTS workflow_drafts;
DROP TABLE IF EXISTS workflow_outputs;
DROP TABLE IF EXISTS workflow_versions;
DROP TABLE IF EXISTS execution_steps;
DROP TABLE IF EXISTS experiments;
DROP TABLE IF EXISTS organizations;
DROP TABLE IF EXISTS outgoing_webhooks;
DROP TABLE IF EXISTS quota_reservations;
DROP TABLE IF EXISTS workflow_schedules;
DROP TABLE IF EXISTS runs;
DROP TABLE IF EXISTS workflows;
