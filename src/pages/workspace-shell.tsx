import { ProjectLink as Link } from "../components/project-link";
import { useEffect, useState, type ReactNode } from "react";
import { NavLink, useNavigate, useLocation } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type AuthSession, type ProjectSummary } from "../lib/api";
import { studioApi } from "../lib/studio-api";
import { WorkspaceContext, readPreference, savePreference } from "../lib/workspace";
import { ConnectRepository } from "./project-overview";
import { Modal, Icon, ErrorMessage } from "../components/product-ui";
export function WorkspaceShell({
  session,
  children,
}: {
  session: AuthSession;
  children: (projectId: string) => ReactNode;
}) {
  const navigate = useNavigate(),
    location = useLocation(),
    cache = useQueryClient(),
    q = useQuery({ queryKey: ["projects", session.user!.id], queryFn: api.projects });
  const [selection, setSelection] = useState(() => {
      const id =
        new URLSearchParams(location.search).get("project") ??
        readPreference("project:" + session.user!.id);
      if (id) savePreference("project:" + session.user!.id, id);
      return id;
    }),
    [menu, setMenu] = useState<
      "projects" | "create" | "account" | "search" | "connect" | "tools" | null
    >(null),
    [name, setName] = useState("");
  const projects = q.data ?? [],
    connectedProjects = projects.filter((p) => Boolean(p.repository)),
    queryProject = new URLSearchParams(location.search).get("project"),
    pathProject = location.pathname.match(/^\/projects\/([^/]+)/)?.[1],
    project =
      (pathProject ? projects.find((p) => p.id === pathProject) : undefined) ??
      projects.find((p) => p.id === new URLSearchParams(location.search).get("project")) ??
      projects.find((p) => p.id === selection) ??
      (connectedProjects.length > 0 ? connectedProjects[0] : projects[0]),
    projectId = project?.id ?? "";
  function selectProject(id: string) {
    if (!projects.some((p) => p.id === id)) return;
    savePreference("project:" + session.user!.id, id);
    setSelection(id);
    setMenu(null);
    // Keep connection setup in context; detail IDs belong to the old project.
    const destination = [
      "/connect",
      "/connections",
      "/investigations",
      "/executions",
      "/traces",
      "/approvals",
      "/workflows",
      "/builder",
    ].includes(location.pathname)
      ? location.pathname
      : "/investigations";
    navigate(destination + "?project=" + encodeURIComponent(id));
  }
  const create = useMutation({
    mutationFn: () => api.createProject(name),
    onSuccess: (p) => {
      cache.setQueryData<ProjectSummary[]>(["projects", session.user!.id], (old) => [
        ...(old ?? []),
        p,
      ]);
      savePreference("project:" + session.user!.id, p.id);
      setSelection(p.id);
      setMenu(null);
      setName("");
      navigate("/investigations?project=" + p.id);
    },
  });
  const logout = useMutation({
    mutationFn: api.logout,
    onSuccess: () => {
      cache.clear();
      window.location.assign("/");
    },
  });
  useEffect(() => {
    function keyboard(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setMenu("search");
      }
    }
    window.addEventListener("keydown", keyboard);
    return () => window.removeEventListener("keydown", keyboard);
  }, []);
  const studio = location.pathname.startsWith("/studio/");
  return (
    <WorkspaceContext.Provider
      value={{
        session,
        projects,
        projectId,
        selectProject,
        openCreateProject: () => {
          create.reset();
          setMenu("create");
        },
        openProjects: () => setMenu("projects"),
      }}
    >
      <div className={"product-shell " + (studio ? "studio-mode" : "")}>
        <header className="product-header">
          <a className="skip-link" href="#workspace-content">
            Skip to content
          </a>
          <Link className="brand" to="/">
            Traceyard<span>.</span>
          </Link>
          <nav aria-label="Main navigation">
            {[
              ["/investigations", "Investigations", "magnifying-glass"],
              ["/projects", "Repositories", "code-branch"],
              ["/connections", "Connections", "plug"],
            ].map(([path, label, icon]) => (
              <NavLink
                key={path}
                to={path! + (projectId ? "?project=" + projectId : "")}
                end={false}
                className={({ isActive }) =>
                  isActive ||
                  (path === "/workflows" &&
                    /^\/(?:builder|studio|workflow|template)(?:\/|$)/.test(location.pathname))
                    ? "active"
                    : ""
                }
              >
                <Icon name={icon!} />
                <span>{label}</span>
              </NavLink>
            ))}
            <button
              className={
                /^\/(workflows|workflow|builder|studio|template|executions|traces|approvals|gateway|laboratory)(\/|$)/.test(
                  location.pathname,
                )
                  ? "workspace-tools active"
                  : "workspace-tools"
              }
              aria-haspopup="dialog"
              onClick={() => setMenu("tools")}
            >
              <Icon name="layer-group" />
              <span>Tools</span>
              <Icon name="chevron-down" />
            </button>
          </nav>
          <div className="header-tools">
            <button
              className="btn icon-only"
              aria-label="Search Traceyard"
              title="Search (Ctrl/⌘ K)"
              onClick={() => setMenu("search")}
            >
              <Icon name="magnifying-glass" />
            </button>
            <button
              className="btn project-switch"
              aria-label="Switch project"
              aria-haspopup="dialog"
              disabled={q.isPending || q.isError}
              onClick={() => setMenu("projects")}
            >
              <Icon name="folder" />
              <span>
                {q.isPending
                  ? "Loading projects…"
                  : (project?.repository ?? project?.name ?? "Choose a project")}
              </span>
              <Icon name="chevron-down" />
            </button>
            <button
              className="btn icon-only"
              aria-label="Account menu"
              aria-haspopup="dialog"
              onClick={() => setMenu("account")}
            >
              <Icon name="circle-user" />
            </button>
          </div>
        </header>
        <main
          id="workspace-content"
          tabIndex={-1}
          className={"product-main " + (studio ? "studio-main" : "")}
        >
          {q.isPending ? (
            <p className="loading-state" role="status">
              Loading your projects…
            </p>
          ) : q.isError ? (
            <section className="connected-panel">
              <h1>Projects could not load</h1>
              <ErrorMessage error={q.error} />
              <button className="btn" onClick={() => void q.refetch()}>
                Try again
              </button>
            </section>
          ) : (pathProject && !projects.some((p) => p.id === pathProject)) ||
            (queryProject && !projects.some((p) => p.id === queryProject)) ? (
            <section className="flow-empty">
              <h1>Project not found</h1>
              <p>This project is unavailable in your account.</p>
              <Link className="btn" to="/projects">
                All projects
              </Link>
            </section>
          ) : !project &&
            !["/", "/investigations", "/projects", "/connections"].includes(location.pathname) ? (
            <section className="first-project">
              <Icon name="folder-open" />
              <h1>Connect your first repository.</h1>
              <p>Choose a GitHub repository to start investigating its code and tests.</p>
              <button className="btn primary" onClick={() => setMenu("connect")}>
                Connect repository
              </button>
            </section>
          ) : (
            children(projectId)
          )}
        </main>
        {menu === "tools" && (
          <Modal title="Workspace tools" close={() => setMenu(null)} className="tools-dialog">
            <div className="tool-menu-grid">
              {[
                [
                  "/workflows",
                  "Workflows",
                  "diagram-project",
                  "Build a workflow from scratch or from a template.",
                ],
                [
                  "/executions",
                  "Workflow runs",
                  "play",
                  "See what ran and recover interrupted work.",
                ],
                ["/traces", "Runtime traces", "wave-square", "Follow activity in a connected app."],
                [
                  "/approvals",
                  "Approvals",
                  "check-double",
                  "Review actions waiting for your decision.",
                ],
                ["/gateway", "Model gateway", "shuffle", "Choose models and manage provider keys."],
                [
                  "/laboratory",
                  "Workflow experiments",
                  "flask",
                  "Compare how workflows handle different scenarios.",
                ],
              ].map(([path, title, icon, description]) => (
                <Link
                  className="tool-menu-item"
                  to={path!}
                  key={path}
                  onClick={() => setMenu(null)}
                >
                  <Icon name={icon!} />
                  <span>
                    <strong>{title}</strong>
                    <small>{description}</small>
                  </span>
                  <Icon name="arrow-right" />
                </Link>
              ))}
            </div>
          </Modal>
        )}
        {menu === "projects" && (
          <Modal
            title="Projects"
            menu
            className="project-switcher"
            close={() => setMenu(null)}
            actions={
              <Link
                className="btn icon-only"
                to="/settings/projects"
                title="Workspace settings"
                aria-label="Workspace settings"
                onClick={() => setMenu(null)}
              >
                <Icon name="gear" />
              </Link>
            }
          >
            <p className="hint">{session.user!.name ?? session.user!.login}’s workspace</p>
            <div className="project-menu-list">
              {projects.length ? (
                projects.map((p) => (
                  <button
                    className="menu-action"
                    key={p.id}
                    aria-pressed={p.id === projectId}
                    onClick={() => selectProject(p.id)}
                  >
                    <Icon
                      name={
                        p.id === projectId
                          ? "circle-check"
                          : p.repository
                            ? "code-branch"
                            : "folder"
                      }
                    />
                    <span>{p.repository ?? p.name}</span>
                  </button>
                ))
              ) : (
                <div className="modal-connect-card">
                  <div className="modal-connect-icon">
                    <i className="fa-brands fa-github" aria-hidden="true" />
                  </div>
                  <p className="modal-connect-title">Connect your first repo</p>
                  <p className="hint">Your connected repos appear here as projects.</p>
                </div>
              )}
            </div>
            <div className="dialog-actions project-menu-actions">
              <Link className="btn" to="/projects" onClick={() => setMenu(null)}>
                All projects
              </Link>
              <button
                className={connectedProjects.length ? "btn" : "btn primary"}
                onClick={() => setMenu("connect")}
              >
                <i className="fa-brands fa-github" aria-hidden="true" />{" "}
                {connectedProjects.length ? "Add another repo" : "Connect repo"}
              </button>
              <button className="btn" onClick={() => setMenu("create")}>
                Create project
              </button>
            </div>
          </Modal>
        )}
        {menu === "connect" && (
          <ConnectRepository
            destination="investigate"
            mode="github"
            close={() => setMenu(null)}
            connected={() => setMenu(null)}
          />
        )}
        {menu === "create" && (
          <Modal title="Create project" close={() => setMenu(null)}>
            <form
              className="form-stack"
              onSubmit={(e) => {
                e.preventDefault();
                create.mutate();
              }}
            >
              <label>
                Project name
                <input
                  autoFocus
                  required
                  maxLength={80}
                  placeholder="e.g. Customer support"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <p className="hint">Organize workflows and connect an application in this project.</p>
              <ErrorMessage error={create.error} />
              <div className="dialog-actions">
                <button className="btn" type="button" onClick={() => setMenu(null)}>
                  Cancel
                </button>
                <button className="btn primary" disabled={create.isPending}>
                  {create.isPending ? "Creating…" : "Create project"}
                </button>
              </div>
            </form>
          </Modal>
        )}
        {menu === "account" && (
          <Modal title={session.user!.name ?? session.user!.login} menu close={() => setMenu(null)}>
            <p className="hint">Signed in as {session.user!.login}</p>
            <div className="project-menu-list">
              {[
                ["/settings/account", "Account settings", "user"],
                ["/settings/projects", "Projects", "folder"],
                ["/settings/appearance", "Appearance", "circle-half-stroke"],
                ["/connect", "Connect application", "plug"],
                ["/settings/developer", "API keys & SDK", "code"],
                ["/gateway", "Model Gateway", "shuffle"],
                ["/laboratory", "Workflow experiments", "flask"],
              ].map(([path, label, icon]) => (
                <Link className="menu-action" to={path!} key={path} onClick={() => setMenu(null)}>
                  <Icon name={icon!} />
                  {label}
                </Link>
              ))}
              <button
                className="menu-action"
                disabled={logout.isPending}
                onClick={() => logout.mutate()}
              >
                <Icon name="arrow-right-from-bracket" />
                Sign out
              </button>
              <ErrorMessage error={logout.error} />
            </div>
          </Modal>
        )}
        {menu === "search" && <Search projectId={projectId} close={() => setMenu(null)} />}
      </div>
    </WorkspaceContext.Provider>
  );
}
function Search({ projectId, close }: { projectId: string; close: () => void }) {
  const [term, setTerm] = useState(""),
    q = useQuery({
      queryKey: ["studio-list", projectId],
      queryFn: () => studioApi.list(projectId),
      enabled: !!projectId,
    });
  const pages = [
    ["Investigations", "/investigations"],
    ["Connections", "/connections"],
    ["Projects", "/settings/projects"],
    ["Connect application", "/connect"],
    ["Executions", "/executions"],
    ["Workflows & agents", "/workflows"],
    ["Traces", "/traces"],
    ["Gateway", "/gateway"],
    ["Laboratory", "/laboratory"],
    ["Approvals", "/approvals"],
    ["Schedules & webhooks", "/settings/automations"],
    ["API keys & SDK", "/settings/developer"],
  ];
  return (
    <Modal title="Search Traceyard" close={close}>
      <label className="sr-only" htmlFor="global-search">
        Search pages and workflows
      </label>
      <input
        id="global-search"
        autoFocus
        placeholder="Find a workflow or page…"
        value={term}
        onChange={(e) => setTerm(e.target.value)}
      />
      <div className="project-menu-list search-results">
        {pages
          .filter(([name]) => name!.toLowerCase().includes(term.toLowerCase()))
          .map(([name, path]) => (
            <Link className="menu-action" to={path!} key={path} onClick={close}>
              {name}
              <Icon name="arrow-right" />
            </Link>
          ))}
        {q.data?.items
          .filter((w) => w.name.toLowerCase().includes(term.toLowerCase()))
          .map((w) => (
            <Link className="menu-action" key={w.id} to={"/studio/" + w.id} onClick={close}>
              <Icon name={w.icon ?? "diagram-project"} />
              {w.name}
            </Link>
          ))}
        <ErrorMessage error={q.error} />
      </div>
    </Modal>
  );
}
