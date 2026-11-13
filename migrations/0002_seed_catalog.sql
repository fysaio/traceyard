-- Seed the built-in sandbox project and the document-intelligence workflow
-- catalog entry. Execution logic lives in shared/workflow/document.ts; an
-- integration test asserts that this manifest and the code definition match.

INSERT INTO projects (id, slug, name, kind, created_at)
VALUES ('prj_sandbox', 'sandbox', 'Public sandbox', 'sandbox', '2026-11-13T00:00:00.000Z');

INSERT INTO workflows (
  id, project_id, slug, name, description, current_version, created_at, updated_at
) VALUES (
  'wf_document_intelligence',
  'prj_sandbox',
  'document-intelligence',
  'Document intelligence',
  'Validates, normalizes and extracts structured insight from a bounded document, verifies the result, then commits it idempotently.',
  1,
  '2026-11-13T00:00:00.000Z',
  '2026-11-13T00:00:00.000Z'
);

INSERT INTO workflow_versions (
  id, workflow_id, version, input_schema_json, steps_json, checksum, created_at
) VALUES (
  'wfv_document_intelligence_v1',
  'wf_document_intelligence',
  1,
  '{"type":"object","additionalProperties":false,"required":["title","document"],"properties":{"title":{"type":"string","minLength":3,"maxLength":120},"document":{"type":"string","minLength":24,"maxLength":10000}}}',
  '[{"key":"validate-input","name":"Validate input","ordinal":1,"description":"Re-validate the stored input at the execution boundary.","timeoutMs":10000,"retry":{"maxAttempts":1,"baseDelayMs":0,"backoff":"fixed","maxDelayMs":0}},{"key":"normalize-content","name":"Normalize content","ordinal":2,"description":"Normalize line endings, whitespace and paragraph structure.","timeoutMs":10000,"retry":{"maxAttempts":3,"baseDelayMs":1000,"backoff":"exponential","maxDelayMs":8000}},{"key":"extract-insights","name":"Extract insights","ordinal":3,"description":"Derive keywords, labelled fields, a summary, reading time and a content digest.","timeoutMs":15000,"retry":{"maxAttempts":3,"baseDelayMs":1000,"backoff":"exponential","maxDelayMs":8000}},{"key":"validate-output","name":"Validate output","ordinal":4,"description":"Verify extraction invariants and recompute the digest.","timeoutMs":10000,"retry":{"maxAttempts":1,"baseDelayMs":0,"backoff":"fixed","maxDelayMs":0}},{"key":"persist-result","name":"Commit result","ordinal":5,"description":"Commit the verified extraction exactly once using a database constraint.","timeoutMs":10000,"retry":{"maxAttempts":3,"baseDelayMs":1000,"backoff":"exponential","maxDelayMs":8000}}]',
  '5f655bc6c00fb077051fdc58e9abe7b4d633d7d3aa12e92ee9b93a095c96bf8d',
  '2026-11-13T00:00:00.000Z'
);

INSERT INTO system_flags (key, value, updated_at)
VALUES ('sandbox_enabled', 'true', '2026-11-13T00:00:00.000Z');
