# Live verification — 18 November 2026

Deployed source: `90206d888dd1992bb25a74add4d1fd2d9f22747e`.
Worker version: `e30ac927-eac6-4ef5-bd59-dc30afbaa650`.
The operator applied migration `0015_execution_recovery.sql` successfully.

Live origin: https://traceyard.pilotsaviour229.workers.dev
Observed frontend asset: `/assets/index-BThEOlKh.js`.
API verification completed: `2026-11-18T05:44:51.167Z`.

## Actual production execution

These requests used a separate anonymous verification session and synthetic document input. No customer data, external HTTP effects or model provider was used. Work was dispatched through the deployed Queue and Cloudflare Workflow bindings; status, attempts, outputs and events were read back through the production API.

| Check                                         | Observed result                                                                                                                          | Run                                    |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| automatic-transient-recovery                  | Succeeded after the controlled transient extraction fault; two actual extraction attempts retained.                                      | `run_a3d1b8602b6348f6acaa5a5f8dcd5c4a` |
| controlled-permanent-failure                  | Failed with DOCUMENT_UNPROCESSABLE; two earlier steps completed and downstream steps did not execute.                                    | `run_a8814d91d2e145d098ad7a29910ff119` |
| resume-retains-checkpoints                    | Reused two completed outputs with zero new attempts and null new duration; the unchanged permanent fault remained failed.                | `run_3ec0d2b7b0054cc0b04a17b7b0c5aa77` |
| linked-fresh-execution-without-injected-fault | Succeeded with edited synthetic input and the injected fault disabled; retained the parent link and left the original failure unchanged. | `run_7a5e7eb8c9cd4117a4ebea0ddeee3bb9` |

The resumed run also contained two persisted `step.reused` provenance events. The anonymous session credential is not included in this evidence. These checks do not establish authenticated Studio, production model-provider or external receiver behavior.

## Signed-in browser verification remains blocked

The new landing screen rendered correctly. The browser reused an existing GitHub authorization, returned to the production callback, and received `GITHUB_PROVIDER_UNAVAILABLE`. A fresh visit remained signed out. Automatic login retries stopped after this failure.

Callback request ID: `b9523648-1776-4148-81d8-53b77ce0be55`.

The current callback uses that error for a token-exchange or profile-fetch network exception, or a GitHub HTTP 429/5xx response. The response does not identify which stage failed. No claim is made that the client secret, callback configuration or platform code is the cause. The Worker callback log is needed to distinguish them. Do not share OAuth callback query strings, tokens or secrets.

## Keyless user journey to verify

Open Workflows → Templates → Parallel processing → Use template → Publish version → Run v1. Submit customer/order JSON, inspect both branches and the merged output, then inspect the event history. This workflow needs no provider credential or repository change. Authenticated approval/rejection and a failed HTTP/model delivery followed by checkpoint recovery still need live verification.
