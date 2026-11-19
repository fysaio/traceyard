import { it, expect, vi } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WorkspaceContext, type WorkspaceState } from "../../src/lib/workspace";
import { RepositoriesPage } from "../../src/pages/repositories";
import { AgentsPage } from "../../src/pages/agents";

const workspace: WorkspaceState = {
  session: {
    user: { id: "u", login: "dev", name: "Dev", avatarUrl: null },
    githubSignInAvailable: true,
    currentSessionId: "s",
    sessions: [],
  },
  projects: [],
  projectId: "",
  selectProject: () => {},
  openConnect: () => {},
};

function render(page: () => ReactElement, seed?: (client: QueryClient) => void) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seed?.(client);
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(
        WorkspaceContext.Provider,
        { value: workspace },
        createElement(MemoryRouter, null, createElement(page)),
      ),
    ),
  );
}

it("offers one clear action when no repository is connected", () => {
  const html = render(RepositoriesPage, (c) =>
    c.setQueryData(["workspace-projects"], { items: [] }),
  );
  expect(html).toContain("Repositories");
  expect(html).toContain("Connect");
});

it("explains agent setup without exposing retired workflow recovery", () => {
  vi.stubGlobal("window", { location: { origin: "https://traceyard.test" } });
  const html = render(AgentsPage);
  vi.unstubAllGlobals();
  expect(html).toContain("https://traceyard.test/mcp");
  expect(html).toContain("Connect an agent");
  expect(html).not.toMatch(/recover/i);
});
