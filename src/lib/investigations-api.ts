import { integrationRequest as request } from "./integrations-api";
import type { Investigation, InvestigationRequest } from "../../shared/contracts/investigations";
import type { Verification } from "../../shared/contracts/verification";
export const investigations = {
  list: (p: string) => request<{ items: Investigation[] }>(p, "investigations"),
  get: (p: string, id: string) =>
    request<Investigation>(p, "investigations/" + encodeURIComponent(id)),
  create: (p: string, body: Partial<InvestigationRequest> & { question: string }) =>
    request<Investigation>(p, "investigations", "POST", body),
  resolveCi: (p: string, url: string) =>
    request<{ commit: string; kind: string; jobUrl: string }>(
      p,
      "investigations/ci-revision",
      "POST",
      { url },
    ),
  flakiness: (p: string, id: string, commit: string, testPath: string) =>
    request<Investigation>(p, `investigations/${encodeURIComponent(id)}/flakiness`, "POST", {
      commit,
      testPath,
    }),
  execute: (p: string, id: string, testPath?: string, testCase?: string) =>
    request<Investigation>(p, `investigations/${encodeURIComponent(id)}/execute`, "POST", {
      testPath,
      testCase,
    }),
  cancel: (p: string, id: string) =>
    request<Investigation>(p, `investigations/${encodeURIComponent(id)}/cancel`, "POST", {}),
  evidence: (p: string, id: string, evidence: string, offset: number) =>
    request<{
      id: string;
      text: string;
      offset: number;
      nextOffset: number | null;
      truncated: boolean;
    }>(
      p,
      `investigations/${encodeURIComponent(id)}/evidence/${encodeURIComponent(evidence)}?offset=${offset}&limit=3000`,
    ),
  verify: (p: string, id: string, commit: string) =>
    request<Verification>(p, `investigations/${encodeURIComponent(id)}/verify`, "POST", { commit }),
  verification: (p: string, id: string) =>
    request<Verification>(p, "verifications/" + encodeURIComponent(id)),
};
