import { it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WorkspaceContext, type WorkspaceState } from "../../src/lib/workspace";
import {
  ProjectsPage,
  ProjectPage,
  OperationPage,
  ApplicationRunPage,
  RunComparePage,
} from "../../src/pages/project-experience";
import type { Catalog } from "../../shared/repository/workspace";
const project = "prj_route",
  op = "op_route",
  trace = "a".repeat(32);
const root = {
  trace_id: trace,
  span_id: "b".repeat(16),
  parent_span_id: null,
  name: "GET /health",
  kind: "workflow",
  status: "SUCCEEDED",
  started_at: "2026-11-16T07:00:00.000Z",
  ended_at: "2026-11-16T07:00:00.050Z",
  attributes_json: "{}",
  input_json: null,
  output_json: null,
  error_json: null,
};
const catalog: Catalog = {
  project: { id: project, name: "Application" },
  repository: null,
  jobs: [],
  warnings: [],
  filesScanned: 1,
  config: { directory: ".", startScript: "start", port: 3000 },
  operations: [
    {
      key: op,
      name: "GET /health",
      kind: "http",
      file: "server.ts",
      line: 1,
      calls: ["loadHealth"],
      evidence: "linked",
      runtimeNames: ["GET /health"],
      runs: 1,
      failed: 0,
      lastRunAt: root.started_at,
      testCases: 0,
    },
  ],
  runs: [
    {
      id: trace,
      name: root.name,
      status: "SUCCEEDED",
      startedAt: root.started_at,
      endedAt: root.ended_at,
      steps: 1,
      attributes: {},
      checkId: null,
      commit: null,
      operationKey: op,
    },
  ],
};
it.each([
  ["/projects", "/projects", ProjectsPage, "/projects/" + project],
  [
    "/projects/:selectedProject",
    "/projects/" + project,
    ProjectPage,
    "/projects/" + project + "/operations/" + op,
  ],
  [
    "/projects/:selectedProject/operations/:operationKey",
    "/projects/" + project + "/operations/" + op,
    OperationPage,
    "/projects/" + project + "/runs/" + trace,
  ],
  [
    "/projects/:selectedProject/runs/:traceId",
    "/projects/" + project + "/runs/" + trace,
    ApplicationRunPage,
    "/projects/" + project + "/operations/" + op,
  ],
  [
    "/projects/:selectedProject/compare",
    "/projects/" + project + "/compare?before=" + trace + "&after=" + trace,
    RunComparePage,
    "/projects/" + project + "/runs/" + trace,
  ],
] as const)(
  "renders the %s route with real contextual navigation and font icons",
  (path, url, Page, target) => {
    const client = new QueryClient({
      defaultOptions: { queries: { staleTime: Infinity, retry: false, gcTime: Infinity } },
    });
    client.setQueryData(["workspace-projects"], {
      items: [
        {
          id: project,
          name: "Application",
          repository: null,
          runs: 1,
          failed: 0,
          lastRunAt: root.started_at,
        },
      ],
    });
    client.setQueryData(["catalog", project], catalog);
    client.setQueryData(["operation", project, op], {
      ...catalog,
      operation: catalog.operations[0],
      cases: [],
    });
    client.setQueryData(["application-run", project, trace], { spans: [root], tests: [] });
    const workspace = {
      projectId: project,
      projects: [{ id: project, name: "Application", slug: "app", createdAt: root.started_at }],
      session: { user: { id: "owner" } },
      selectProject: () => {},
      openCreateProject: () => {},
      openProjects: () => {},
    } as unknown as WorkspaceState;
    const html = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client },
        createElement(
          WorkspaceContext.Provider,
          { value: workspace },
          createElement(
            MemoryRouter,
            { initialEntries: [url] },
            createElement(
              Routes,
              null,
              createElement(Route, { path, element: createElement(Page) }),
            ),
          ),
        ),
      ),
    );
    expect(html).toContain('href="' + target + '"');
    expect(html).toContain("fa-solid");
    expect(html).not.toContain("<svg");
    expect(html).toContain("<h1");
    client.clear();
  },
);
