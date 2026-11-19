import { Navigate, Route, Routes, useLocation, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, type AuthSession } from "./lib/api";
import { Welcome } from "./components/welcome";
import { Empty, ErrorMessage, Spinner } from "./components/ui";
import { ProjectLink as Link } from "./components/project-link";
import { WorkspaceShell } from "./pages/workspace-shell";
import { InvestigationsPage, InvestigationPage } from "./pages/investigations";
import { AgentsPage } from "./pages/agents";
import { RepositoriesPage, RepositoryPage, CheckPage, RepositorySetup } from "./pages/repositories";
import { SettingsPage } from "./pages/settings";

export function App() {
  const session = useQuery({
    queryKey: ["auth"],
    queryFn: api.authSession,
    retry: false,
    refetchInterval: 60000,
    refetchOnWindowFocus: true,
  });
  if (session.isPending)
    return (
      <main className="boot">
        <Spinner label="Loading Traceyard…" />
      </main>
    );
  if (session.isError)
    return (
      <main className="boot">
        <div className="card stack">
          <h1>Traceyard is unreachable</h1>
          <ErrorMessage error={session.error} />
          <div>
            <button className="btn" onClick={() => void session.refetch()}>
              Try again
            </button>
          </div>
        </div>
      </main>
    );
  if (!session.data.user) return <Welcome session={session.data} />;
  return <Workspace session={session.data} />;
}

/** Old addresses keep working: /projects/* became /repositories/*, /connections became /agents. */
function LegacyRedirect({ to }: { to: string }) {
  const params = useParams(),
    location = useLocation();
  const path = to
    .replace(":id", encodeURIComponent(params.id ?? ""))
    .replace(":checkId", encodeURIComponent(params.checkId ?? ""));
  return <Navigate to={path + location.search + location.hash} replace />;
}

function Workspace({ session }: { session: AuthSession }) {
  return (
    <WorkspaceShell session={session}>
      {(projectId) => (
        <Routes>
          <Route
            path="/"
            element={
              <Navigate
                to={
                  "/investigations" + (projectId ? "?project=" + encodeURIComponent(projectId) : "")
                }
                replace
              />
            }
          />
          <Route path="/investigations" element={<InvestigationsPage key={projectId} />} />
          <Route path="/investigations/:id" element={<InvestigationPage key={projectId} />} />
          <Route path="/agents" element={<AgentsPage key={projectId} />} />
          <Route path="/repositories" element={<RepositoriesPage />} />
          <Route path="/repositories/:id" element={<RepositoryPage key={projectId} />} />
          <Route path="/repositories/:id/checks/:checkId" element={<CheckPage key={projectId} />} />
          <Route path="/repository-setup" element={<RepositorySetup />} />
          <Route path="/settings" element={<Navigate to="/settings/account" replace />} />
          <Route path="/settings/:section" element={<SettingsPage session={session} />} />
          <Route path="/connections" element={<LegacyRedirect to="/agents" />} />
          <Route path="/projects" element={<LegacyRedirect to="/repositories" />} />
          <Route path="/projects/:id" element={<LegacyRedirect to="/repositories/:id" />} />
          <Route
            path="/projects/:id/checks/:checkId"
            element={<LegacyRedirect to="/repositories/:id/checks/:checkId" />}
          />
          <Route
            path="*"
            element={
              <Empty
                title="Page not found"
                action={
                  <Link className="btn" to="/investigations">
                    Go to investigations
                  </Link>
                }
              >
                This address doesn’t exist in Traceyard.
              </Empty>
            }
          />
        </Routes>
      )}
    </WorkspaceShell>
  );
}
