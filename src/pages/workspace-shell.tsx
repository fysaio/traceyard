import { useEffect, useRef, useState, type ReactNode } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ProjectLink as Link } from "../components/project-link";
import { api, type AuthSession } from "../lib/api";
import { WorkspaceContext, readPreference, savePreference } from "../lib/workspace";
import { ConnectRepository } from "./repositories";
import { Empty, ErrorMessage, GitHubMark, Icon, Spinner, type IconName } from "../components/ui";

const NAV: [path: string, label: string, icon: IconName][] = [
  ["/investigations", "Investigations", "bug"],
  ["/repositories", "Repositories", "repository"],
  ["/agents", "Agents", "agent"],
];

/** Pages that work before a repository is connected. */
const OPEN_PATHS = /^\/(?:investigations|repositories|agents|settings(?:\/.*)?|repository-setup)?$/;

export function WorkspaceShell({
  session,
  children,
}: {
  session: AuthSession;
  children: (projectId: string) => ReactNode;
}) {
  const navigate = useNavigate(),
    location = useLocation(),
    user = session.user!,
    q = useQuery({ queryKey: ["projects", user.id], queryFn: api.projects });
  const [selection, setSelection] = useState(() => {
    const id =
      new URLSearchParams(location.search).get("project") ?? readPreference("project:" + user.id);
    if (id) savePreference("project:" + user.id, id);
    return id;
  });
  const [menu, setMenu] = useState<"repositories" | "account" | "connect" | null>(null);
  const projects = q.data ?? [],
    repositories = projects.filter((p) => Boolean(p.repository)),
    queryProject = new URLSearchParams(location.search).get("project"),
    pathProject = location.pathname.match(/^\/repositories\/([^/]+)/)?.[1],
    project =
      (pathProject ? projects.find((p) => p.id === pathProject) : undefined) ??
      projects.find((p) => p.id === queryProject) ??
      projects.find((p) => p.id === selection) ??
      repositories[0] ??
      projects[0],
    projectId = project?.id ?? "";

  function selectProject(id: string) {
    if (!projects.some((p) => p.id === id)) return;
    savePreference("project:" + user.id, id);
    setSelection(id);
    setMenu(null);
    // Detail pages belong to the previous repository, so fall back to its list page.
    const section = location.pathname.split("/")[1];
    const destination =
      section === "repositories"
        ? "/repositories/" + encodeURIComponent(id)
        : section === "agents"
          ? "/agents"
          : "/investigations";
    navigate(destination + "?project=" + encodeURIComponent(id));
  }

  const missing =
    (pathProject && !projects.some((p) => p.id === pathProject)) ||
    (queryProject && !projects.some((p) => p.id === queryProject));

  return (
    <WorkspaceContext.Provider
      value={{ session, projects, projectId, selectProject, openConnect: () => setMenu("connect") }}
    >
      <div className="shell">
        <a className="skip-link" href="#content">
          Skip to content
        </a>
        <header className="topbar">
          <div className="topbar-inner">
            <Link className="brand" to="/investigations" aria-label="Traceyard home">
              Traceyard<span>.</span>
            </Link>
            <nav className="nav" aria-label="Main">
              {NAV.map(([path, label, icon]) => (
                <NavLink
                  key={path}
                  to={path + (projectId ? "?project=" + encodeURIComponent(projectId) : "")}
                  className={({ isActive }) => (isActive ? "active" : undefined)}
                >
                  <Icon name={icon} />
                  <span>{label}</span>
                </NavLink>
              ))}
            </nav>
            <div className="topbar-tools">
              {repositories.length > 0 && (
                <Popover
                  open={menu === "repositories"}
                  onClose={() => setMenu(null)}
                  trigger={
                    <button
                      className="btn ghost switcher"
                      aria-haspopup="menu"
                      aria-expanded={menu === "repositories"}
                      disabled={q.isPending || q.isError}
                      onClick={() => setMenu(menu === "repositories" ? null : "repositories")}
                    >
                      <Icon name="branch" />
                      <span className="truncate">
                        {q.isPending
                          ? "Loading…"
                          : project?.repository
                            ? project.repository
                            : "Choose repository"}
                      </span>
                      <Icon name="chevron-down" size={14} />
                    </button>
                  }
                >
                  <p className="menu-label">Repositories</p>
                  {repositories.map((p) => (
                    <button
                      key={p.id}
                      role="menuitemradio"
                      aria-checked={p.id === projectId}
                      className="menu-item"
                      onClick={() => selectProject(p.id)}
                    >
                      <span className="truncate">{p.repository}</span>
                      {p.id === projectId && <Icon name="check" />}
                    </button>
                  ))}
                  <hr />
                  <button role="menuitem" className="menu-item" onClick={() => setMenu("connect")}>
                    <Icon name="plus" />
                    Connect repository
                  </button>
                </Popover>
              )}
              <Popover
                open={menu === "account"}
                onClose={() => setMenu(null)}
                align="end"
                trigger={
                  <button
                    className="avatar-button"
                    aria-label="Account menu"
                    aria-haspopup="menu"
                    aria-expanded={menu === "account"}
                    onClick={() => setMenu(menu === "account" ? null : "account")}
                  >
                    {user.avatarUrl ? (
                      <img src={user.avatarUrl} alt="" width={28} height={28} />
                    ) : (
                      <Icon name="user" />
                    )}
                  </button>
                }
              >
                <div className="menu-identity">
                  <strong className="truncate">{user.name ?? user.login}</strong>
                  <span className="truncate">@{user.login}</span>
                </div>
                <hr />
                <AccountLinks close={() => setMenu(null)} />
              </Popover>
            </div>
          </div>
        </header>
        <main id="content" tabIndex={-1} className="content">
          {q.isPending ? (
            <Spinner label="Loading your repositories…" />
          ) : q.isError ? (
            <div className="card stack">
              <h1>Repositories could not load</h1>
              <ErrorMessage error={q.error} />
              <div>
                <button className="btn" onClick={() => void q.refetch()}>
                  Try again
                </button>
              </div>
            </div>
          ) : missing ? (
            <Empty
              title="Repository not found"
              action={
                <Link className="btn" to="/repositories">
                  All repositories
                </Link>
              }
            >
              It isn’t connected to your account, or you no longer have access.
            </Empty>
          ) : !project && !OPEN_PATHS.test(location.pathname) ? (
            <Empty
              title="Connect your first repository"
              action={
                <button className="btn primary" onClick={() => setMenu("connect")}>
                  <GitHubMark /> Connect repository
                </button>
              }
            >
              Choose a GitHub repository to start reproducing failing tests.
            </Empty>
          ) : (
            children(projectId)
          )}
        </main>
        <nav className="tabbar" aria-label="Main">
          {NAV.map(([path, label, icon]) => (
            <NavLink
              key={path}
              to={path + (projectId ? "?project=" + encodeURIComponent(projectId) : "")}
              className={({ isActive }) => (isActive ? "active" : undefined)}
            >
              <Icon name={icon} size={20} />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>
        {menu === "connect" && (
          <ConnectRepository close={() => setMenu(null)} connected={() => setMenu(null)} />
        )}
      </div>
    </WorkspaceContext.Provider>
  );
}

function AccountLinks({ close }: { close: () => void }) {
  const cache = useQueryClient();
  const logout = useMutation({
    mutationFn: api.logout,
    onSuccess: () => {
      cache.clear();
      window.location.assign("/");
    },
  });
  return (
    <>
      <Link role="menuitem" className="menu-item" to="/settings/account" onClick={close}>
        <Icon name="user" />
        Account
      </Link>
      <Link role="menuitem" className="menu-item" to="/settings/appearance" onClick={close}>
        <Icon name="settings" />
        Appearance
      </Link>
      <button
        role="menuitem"
        className="menu-item"
        disabled={logout.isPending}
        onClick={() => logout.mutate()}
      >
        <Icon name="sign-out" />
        {logout.isPending ? "Signing out…" : "Sign out"}
      </button>
      <ErrorMessage error={logout.error} />
    </>
  );
}

/** A small anchored menu. Closes on Escape, outside click and route change. */
function Popover({
  open,
  onClose,
  trigger,
  children,
  align = "start",
}: {
  open: boolean;
  onClose: () => void;
  trigger: ReactNode;
  children: ReactNode;
  align?: "start" | "end";
}) {
  const ref = useRef<HTMLDivElement>(null),
    close = useRef(onClose),
    location = useLocation();
  useEffect(() => {
    close.current = onClose;
  });
  useEffect(() => {
    if (!open) return;
    const pointer = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) close.current();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        close.current();
        ref.current?.querySelector<HTMLElement>("[aria-haspopup]")?.focus();
      }
    };
    document.addEventListener("pointerdown", pointer);
    document.addEventListener("keydown", key);
    ref.current?.querySelector<HTMLElement>("[role^=menuitem]")?.focus();
    return () => {
      document.removeEventListener("pointerdown", pointer);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  useEffect(() => close.current(), [location.pathname]);
  return (
    <div className="popover-anchor" ref={ref}>
      {trigger}
      {open && (
        <div className={"popover " + align} role="menu">
          {children}
        </div>
      )}
    </div>
  );
}
