import { connectionExample } from "../lib/connection-examples";
import { ProjectLink as Link } from "../components/project-link";
import { useEffect, useState, type ReactNode } from "react";
import { NavLink, useParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useWorkspace, readPreference, savePreference } from "../lib/workspace";
import { integrationRequest as request } from "../lib/integrations-api";
import { Icon, ErrorMessage, Modal } from "../components/product-ui";
import { Developer, Automations } from "./integrations";
import type { ProjectSummary } from "../lib/api";
interface ConnectionStatus {
  project: ProjectSummary;
  activeKeys: number;
  lastKeyUsedAt: string | null;
  traces: number;
  lastTraceReceivedAt: string | null;
  workflows: number;
  executions: number;
}
export function SettingsLayout({ account }: { account: ReactNode }) {
  const { section = "projects" } = useParams(),
    { projectId } = useWorkspace();
  return (
    <>
      <div className="page-head">
        <h1>Settings</h1>
      </div>
      <div className="settings-layout">
        <nav aria-label="Settings sections">
          {[
            ["account", "Account"],
            ["projects", "Projects"],
            ["appearance", "Appearance"],
            ["connections", "HTTP connections"],
            ["developer", "API keys & SDK"],
            ["automations", "Schedules & webhooks"],
          ].map(([id, name]) => (
            <NavLink key={id} to={"/settings/" + id}>
              {name}
            </NavLink>
          ))}
        </nav>
        <div className="settings-content">
          {section === "account" ? (
            account
          ) : section === "appearance" ? (
            <Appearance />
          ) : section === "developer" ? (
            <Developer projectId={projectId} />
          ) : section === "automations" ? (
            <Automations projectId={projectId} />
          ) : section === "connections" ? (
            <HttpConnections />
          ) : (
            <Projects />
          )}
        </div>
      </div>
    </>
  );
}
export function Projects() {
  const { projects, projectId, selectProject, openCreateProject } = useWorkspace();
  return (
    <>
      <div className="section-head">
        <div>
          <h2>Projects</h2>
          <p className="hint">Choose where your workflows and application traces belong.</p>
        </div>
        <button className="btn primary" onClick={openCreateProject}>
          <Icon name="plus" />
          Create project
        </button>
      </div>
      <div className="project-grid">
        {projects.map((p) => (
          <ProjectCard
            key={p.id}
            project={p}
            current={p.id === projectId}
            open={() => selectProject(p.id)}
          />
        ))}
      </div>
    </>
  );
}
function ProjectCard({
  project,
  current,
  open,
}: {
  project: ProjectSummary;
  current: boolean;
  open: () => void;
}) {
  const cache = useQueryClient(),
    { session } = useWorkspace(),
    [editing, setEditing] = useState(false),
    [name, setName] = useState(project.name);
  const q = useQuery({
      queryKey: ["connection-status", project.id],
      queryFn: () => request<ConnectionStatus>(project.id, "connection-status"),
    }),
    save = useMutation({
      mutationFn: async () => {
        const response = await fetch("/api/projects/" + encodeURIComponent(project.id), {
          method: "PATCH",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        });
        const b = (await response.json()) as { error?: { message: string } };
        if (!response.ok) throw Error(b.error?.message ?? "Project could not be renamed.");
      },
      onSuccess: () => {
        setEditing(false);
        void cache.invalidateQueries({ queryKey: ["projects", session.user!.id] });
      },
    });
  return (
    <article className="connected-panel project-card">
      <div className="integration-row">
        <span className="workflow-icon">
          <Icon name="folder" />
        </span>
        {current && <span className="badge">Current project</span>}
      </div>
      <h3>{project.name}</h3>
      <p className="hint">
        {q.isPending
          ? "Loading project…"
          : q.isError
            ? "Project status unavailable"
            : `${q.data!.workflows} workflows · ${q.data!.executions} executions`}
      </p>
      <p className="connection-label">
        <Icon name={q.data?.lastTraceReceivedAt ? "circle-check" : "plug"} />
        {q.data?.lastTraceReceivedAt
          ? "Application traces received"
          : "No application connected yet"}
      </p>
      <div className="actions">
        <button className="btn" onClick={open}>
          {current ? "Open project" : "Open project"}
        </button>
        <button className="btn" onClick={() => setEditing(true)}>
          Rename
        </button>
        {current && (
          <Link className="btn" to="/connect">
            Connect application
          </Link>
        )}
      </div>
      <ErrorMessage error={q.error} />
      {editing && (
        <Modal title="Rename project" close={() => setEditing(false)}>
          <form
            className="form-stack"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate();
            }}
          >
            <label>
              Project name
              <input
                autoFocus
                required
                maxLength={80}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <ErrorMessage error={save.error} />
            <div className="dialog-actions">
              <button type="button" className="btn" onClick={() => setEditing(false)}>
                Cancel
              </button>
              <button className="btn primary" disabled={save.isPending}>
                Save name
              </button>
            </div>
          </form>
        </Modal>
      )}
    </article>
  );
}
function Appearance() {
  const [theme, setTheme] = useState(() => readPreference("theme", "system"));
  useEffect(() => {
    savePreference("theme", theme);
    const media = matchMedia("(prefers-color-scheme:dark)"),
      apply = () =>
        (document.documentElement.dataset.theme =
          theme === "system" ? (media.matches ? "dark" : "light") : theme);
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);
  return (
    <section>
      <h2>Appearance</h2>
      <p className="hint">Choose the theme that works for you.</p>
      <div className="segmented section" role="group" aria-label="Color theme">
        {["light", "dark", "system"].map((t) => (
          <button
            className={t === theme ? "selected" : ""}
            aria-pressed={t === theme}
            key={t}
            onClick={() => setTheme(t)}
          >
            {t[0]!.toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
    </section>
  );
}
export function ConnectApplication() {
  const { projectId, projects, openProjects } = useWorkspace(),
    q = useQuery({
      queryKey: ["connection-status", projectId],
      queryFn: () => request<ConnectionStatus>(projectId, "connection-status"),
      refetchInterval: 3000,
    }),
    [name, setName] = useState("Application server"),
    [token, setToken] = useState(""),
    [transport, setTransport] = useState("typescript"),
    [copied, setCopied] = useState(false);
  const create = useMutation({
    mutationFn: () =>
      request<{ token: string }>(projectId, "keys", "POST", { name, scopes: ["traces:write"] }),
    onSuccess: (r) => setToken(r.token),
  });
  const origin = window.location.origin,
    code = connectionExample(origin, name, transport);
  return (
    <>
      <Link className="back" to="/">
        {" "}
        <Icon name="arrow-left" /> Workflows
      </Link>
      <div className="page-head">
        <div>
          <h1>Connect your application</h1>
          <p>Send an execution trace from your server into this project.</p>
        </div>
      </div>
      <div className="connection-setup">
        <section className="setup-step">
          <span className="setup-number">1</span>
          <div>
            <h2>Choose the project</h2>
            <p>Traces and API keys stay within this project.</p>
            <button className="btn section" onClick={openProjects}>
              <Icon name="folder" />
              {projects.find((p) => p.id === projectId)?.name}
              <Icon name="chevron-down" />
            </button>
          </div>
        </section>
        <section className="setup-step">
          <span className="setup-number">2</span>
          <div>
            <h2>Create a server key</h2>
            <p>Keep it in your server’s TRACEYARD_KEY environment variable.</p>
            {!token ? (
              <form
                className="form-stack"
                onSubmit={(e) => {
                  e.preventDefault();
                  create.mutate();
                }}
              >
                <label>
                  Application name
                  <input
                    required
                    maxLength={80}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </label>
                <button className="btn primary" disabled={create.isPending}>
                  {create.isPending ? "Creating…" : "Create connection key"}
                </button>
                <ErrorMessage error={create.error} />
              </form>
            ) : (
              <div className="secret-reveal section">
                <p>This key is shown once.</p>
                <code>{token}</code>
                <button
                  className="btn section"
                  onClick={() =>
                    void navigator.clipboard
                      .writeText(token)
                      .then(() => setCopied(true))
                      .catch(() => setCopied(false))
                  }
                >
                  {copied ? "Copied" : "Copy key"}
                </button>
              </div>
            )}
          </div>
        </section>
        <section className="setup-step">
          <span className="setup-number">3</span>
          <div>
            <h2>Send your first trace</h2>
            <div className="segmented section" role="group" aria-label="Connection method">
              {[
                ["typescript", "TypeScript"],
                ["http", "HTTP"],
              ].map(([id, label]) => (
                <button
                  className={transport === id ? "selected" : ""}
                  aria-pressed={transport === id}
                  key={id}
                  onClick={() => setTransport(id!)}
                >
                  {label}
                </button>
              ))}
            </div>
            {transport === "typescript" && (
              <p className="hint">
                Copy{" "}
                <a
                  className="text-link"
                  href="https://github.com/fysaio/traceyard/blob/main/sdk/client.ts"
                  target="_blank"
                  rel="noreferrer"
                >
                  sdk/client.ts
                </a>{" "}
                into your application as traceyard-client.ts.
              </p>
            )}
            <pre className="code">{code}</pre>
            <p className="hint">
              Run this on your server. GitHub sign-in authenticates your account; your application
              connects by sending traces.
            </p>
          </div>
        </section>
        <section className="setup-step">
          <span className="setup-number">4</span>
          <div aria-live="polite">
            <h2>
              {q.data?.lastTraceReceivedAt
                ? "Your project has received traces"
                : "Waiting for your first trace"}
            </h2>
            {q.data?.lastTraceReceivedAt ? (
              <>
                <p>Last received {new Date(q.data.lastTraceReceivedAt).toLocaleString()}.</p>
                <div className="actions section">
                  <Link className="btn primary" to="/traces">
                    Open traces <Icon name="arrow-right" />
                  </Link>
                  <Link className="btn" to="/">
                    View workflows
                  </Link>
                </div>
              </>
            ) : (
              <>
                <p>The connection is confirmed when the server receives an actual span.</p>
                <button
                  className="btn section"
                  disabled={q.isFetching}
                  onClick={() => void q.refetch()}
                >
                  Check connection
                </button>
              </>
            )}
            <ErrorMessage error={q.error} />
          </div>
        </section>
      </div>
    </>
  );
}
interface HttpData {
  items: { id: string; name: string; url: string; method: string; authenticated: number }[];
  allowedHosts: string[];
  secretStorageConfigured: boolean;
}
export function HttpConnections() {
  const { projectId } = useWorkspace(),
    cache = useQueryClient(),
    q = useQuery({
      queryKey: ["http-connections", projectId],
      queryFn: () => request<HttpData>(projectId, "http-connections"),
    }),
    [name, setName] = useState(""),
    [url, setUrl] = useState(""),
    [method, setMethod] = useState("POST"),
    [token, setToken] = useState("");
  const save = useMutation({
      mutationFn: () =>
        request(projectId, "http-connections", "POST", {
          name,
          url,
          method,
          ...(token ? { token } : {}),
        }),
      onSuccess: () => {
        setToken("");
        setName("");
        setUrl("");
        void cache.invalidateQueries({ queryKey: ["http-connections", projectId] });
      },
    }),
    remove = useMutation({
      mutationFn: (id: string) => request(projectId, "http-connections/" + id, "DELETE"),
      onSuccess: () => cache.invalidateQueries({ queryKey: ["http-connections", projectId] }),
    });
  return (
    <section>
      <h2>HTTP connections</h2>
      <p className="hint">Connect a permitted JSON API for workflow Tool steps.</p>
      <div className="compact-stack section">
        {q.data?.items.map((c) => (
          <article className="connected-panel" key={c.id}>
            <h3>{c.name}</h3>
            <p className="hint">
              {c.method} · {c.url}
            </p>
            <button
              className="btn section"
              disabled={remove.isPending}
              onClick={() => remove.mutate(c.id)}
            >
              Remove connection
            </button>
          </article>
        ))}
      </div>
      <form
        className="connected-panel form-stack section"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <h3>Add connection</h3>
        <label>
          Name
          <input required value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="form-grid">
          <label>
            Method
            <select value={method} onChange={(e) => setMethod(e.target.value)}>
              {["GET", "POST", "PUT", "PATCH"].map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </label>
          <label>
            Destination URL
            <input required type="url" value={url} onChange={(e) => setUrl(e.target.value)} />
          </label>
        </div>
        <label>
          Bearer token (optional)
          <input
            type="password"
            autoComplete="off"
            maxLength={4096}
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
        </label>
        <p className="hint">
          Allowed hosts:{" "}
          {q.data?.allowedHosts.join(", ") || "Configure OUTBOUND_ALLOWED_HOSTS on the Worker."}
        </p>
        <button className="btn primary" disabled={save.isPending || !q.data?.allowedHosts.length}>
          Save connection
        </button>
        <ErrorMessage error={q.error || save.error || remove.error} />
      </form>
    </section>
  );
}
