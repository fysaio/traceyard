-- Retry policy correction.
--
-- `maxDelayMs` was stored in the workflow manifest but never passed to
-- Cloudflare Workflows (which has no delay cap), so the inspector displayed a
-- guarantee the runtime did not enforce. The manifest now records only the
-- fields the runtime actually applies: max attempts, base delay and backoff.
UPDATE workflow_versions
   SET steps_json = '[{"key":"validate-input","name":"Validate input","ordinal":1,"description":"Re-validate the stored input at the execution boundary.","timeoutMs":10000,"retry":{"maxAttempts":1,"baseDelayMs":0,"backoff":"fixed"}},{"key":"normalize-content","name":"Normalize content","ordinal":2,"description":"Normalize line endings, whitespace and paragraph structure.","timeoutMs":10000,"retry":{"maxAttempts":3,"baseDelayMs":1000,"backoff":"exponential"}},{"key":"extract-insights","name":"Extract insights","ordinal":3,"description":"Derive keywords, labelled fields, a summary, reading time and a content digest.","timeoutMs":15000,"retry":{"maxAttempts":3,"baseDelayMs":1000,"backoff":"exponential"}},{"key":"validate-output","name":"Validate output","ordinal":4,"description":"Verify extraction invariants and recompute the digest.","timeoutMs":10000,"retry":{"maxAttempts":1,"baseDelayMs":0,"backoff":"fixed"}},{"key":"persist-result","name":"Commit result","ordinal":5,"description":"Commit the verified extraction exactly once using a database constraint.","timeoutMs":10000,"retry":{"maxAttempts":3,"baseDelayMs":1000,"backoff":"exponential"}}]'
 WHERE id = 'wfv_document_intelligence_v1';
