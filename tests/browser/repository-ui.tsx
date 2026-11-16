/** Development-only visual fixture. Not an input to the production build. */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { RepositoryPicker, type RepositoryChoices } from "../../src/components/repository-picker";
import { Modal } from "../../src/components/product-ui";
import { WorkspaceShell } from "../../src/pages/workspace-shell";
import type { AuthSession } from "../../src/lib/api";
import "../../src/styles/font.css";
import "../../src/styles/base.css";
import "../../src/styles/layout.css";
import "../../src/styles/polish.css";
import "../../src/styles/connected.css";
import "../../src/styles/product-restoration.css";
import "../../src/styles/project-experience.css";
import "../../src/styles/repository-connection.css";
import "@fortawesome/fontawesome-free/css/fontawesome.min.css";
import "@fortawesome/fontawesome-free/css/solid.min.css";
import "@fortawesome/fontawesome-free/css/brands.min.css";

const query = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = query.get("theme") ?? "dark";
const state = query.get("state") ?? "installed";
const data: RepositoryChoices = {
  configured: true,
  installationCount: state === "new" ? 0 : 1,
  installUrl: "https://github.com/apps/example-only/installations/new",
  manageUrl: state === "new" ? null : "https://github.com/settings/installations/7",
  items: ["new", "empty"].includes(state)
    ? []
    : [
        "somni",
        "traceyard",
        "customer-portal",
        "research-service",
        "an-application-with-a-deliberately-long-repository-name-to-check-wrapping",
        ...Array.from({ length: 15 }, (_, i) => "service-" + (i + 1)),
      ].map((name, id) => ({ id: id + 1, installationId: 7, name: "example/" + name })),
};

const client = new QueryClient({
  defaultOptions: { queries: { staleTime: Infinity, retry: false } },
});
client.setQueryData(["projects", "visual-acceptance"], []);
const session: AuthSession = {
  user: { id: "visual-acceptance", login: "example", name: "Acceptance account", avatarUrl: null },
  githubSignInAvailable: true,
  currentSessionId: "visual-session",
  sessions: [],
};

function Fixture() {
  const [connectingId, setConnectingId] = useState<number>();
  const [local, setLocal] = useState(false);
  const [open, setOpen] = useState(true);
  if (state === "workspace")
    return <WorkspaceShell session={session}>{() => <h1>Projects</h1>}</WorkspaceShell>;
  return (
    <>
      <main className="product-main">
        <h1>Repository connection acceptance</h1>
      </main>
      {open && (
        <Modal
          title={local ? "Local project" : "Connect a repo"}
          close={() => setOpen(false)}
          className="repository-dialog"
        >
          {local ? (
            <p>Local setup selected.</p>
          ) : (
            <RepositoryPicker
              data={state === "error" || state === "loading" ? undefined : data}
              loading={state === "loading"}
              refreshing={state === "loading"}
              error={state === "error" ? Error("GitHub could not be reached. Try again.") : null}
              connectingId={connectingId}
              onConnect={(repo) => setConnectingId(repo.id)}
              onRefresh={() => setConnectingId(undefined)}
              onLocal={() => setLocal(true)}
            />
          )}
        </Modal>
      )}
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={client}>
    <MemoryRouter initialEntries={["/projects"]}>
      <Fixture />
    </MemoryRouter>
  </QueryClientProvider>,
);
