import { ProjectActivity } from "./project-overview";
import { ProjectLink as Link } from "../components/project-link";
import { Icon } from "../components/product-ui";
import { useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "../lib/api";
import {
  integrationRequest as request,
  integrations,
  type RouteRecord,
  type ExperimentConfig,
} from "../lib/integrations-api";
import { modelRouteSchema, type ModelRouteConfig } from "../../shared/contracts/gateway";
function inputJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error("Enter valid JSON before continuing.");
  }
}
export function ErrorNotice({ error }: { error: unknown }) {
  return error ? (
    <p className="request-error" role="alert">
      {error instanceof Error ? error.message : "Request failed."}
    </p>
  ) : null;
}
function Title({ title, children }: { title: string; children?: ReactNode }) {
  const Heading = useLocation().pathname.startsWith("/settings/") ? "h2" : "h1";
  return (
    <div className="page-head">
      <div>
        <Heading>{title}</Heading>
        {children && <p>{children}</p>}
      </div>
    </div>
  );
}
function Data({ value }: { value: unknown }) {
  return (
    <pre className="code">{typeof value === "string" ? value : JSON.stringify(value, null, 2)}</pre>
  );
}
export function Badge({ status }: { status: string }) {
  const color = ["PASSED", "APPROVED"].includes(status)
    ? "succeeded"
    : ["REJECTED", "EXPIRED"].includes(status)
      ? "failed"
      : status.toLowerCase();
  return <span className={"status " + color}>{status.toLowerCase().replaceAll("_", " ")}</span>;
}
function Wait({ loading, error }: { loading: boolean; error: unknown }) {
  return (
    <>
      {loading && <p role="status">Loading…</p>}
      <ErrorNotice error={error} />
    </>
  );
}
export function Gateway({ projectId: p }: { projectId: string }) {
  const cache = useQueryClient(),
    data = useQuery({ queryKey: ["gateway", p], queryFn: () => integrations.gateway(p) }),
    [provider, setProvider] = useState("groq"),
    [key, setKey] = useState(""),
    [account, setAccount] = useState(""),
    [editing, setEditing] = useState<RouteRecord | null | undefined>(undefined),
    [route, setRoute] = useState(""),
    [prompt, setPrompt] = useState("");
  const refresh = () => cache.invalidateQueries({ queryKey: ["gateway", p] });
  const credentials = useMutation({
      mutationFn: () =>
        request(p, "gateway/credentials/" + provider, "PUT", {
          apiKey: key,
          ...(provider === "workers" ? { accountId: account } : {}),
        }),
      onSuccess: () => {
        setKey("");
        setAccount("");
        void refresh();
      },
    }),
    remove = useMutation({
      mutationFn: (provider: string) => request(p, "gateway/credentials/" + provider, "DELETE"),
      onSuccess: refresh,
    }),
    delRoute = useMutation({
      mutationFn: (id: string) => request(p, "gateway/routes/" + id, "DELETE"),
      onSuccess: refresh,
    }),
    play = useMutation({
      mutationFn: () => integrations.play(p, route, prompt),
      onSuccess: refresh,
    });
  return (
    <>
      <Title title="Model gateway">
        Connect a provider and choose how workflow model requests are routed.
      </Title>
      <Wait loading={data.isPending} error={data.error} />
      <div className="integration-columns">
        <section className="connected-panel">
          <h2>Providers</h2>
          {data.data && !data.data.secretStorageConfigured && (
            <p className="hint">
              Set INTEGRATION_ENCRYPTION_KEY on the Worker to enable encrypted credential storage.
            </p>
          )}
          <div className="compact-stack">
            {data.data?.credentials.map((c) => (
              <div className="integration-row" key={c.provider}>
                <div>
                  <strong>{c.provider === "workers" ? "Workers AI" : c.provider}</strong>
                  <p className="hint">
                    Credentials stored · {new Date(c.updated_at).toLocaleDateString()}
                  </p>
                </div>
                <button
                  className="btn"
                  onClick={() => remove.mutate(c.provider)}
                  disabled={remove.isPending}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
          <form
            className="form-stack"
            onSubmit={(e) => {
              e.preventDefault();
              credentials.mutate();
            }}
          >
            <label>
              Provider
              <select value={provider} onChange={(e) => setProvider(e.target.value)}>
                <option value="groq">Groq</option>
                <option value="openai">OpenAI</option>
                <option value="workers">Workers AI</option>
              </select>
            </label>
            {provider === "workers" && (
              <label>
                Cloudflare account ID
                <input
                  required
                  pattern="[a-f0-9]{32}"
                  value={account}
                  onChange={(e) => setAccount(e.target.value)}
                />
              </label>
            )}
            <label>
              API key
              <input
                type="password"
                autoComplete="off"
                required
                minLength={8}
                maxLength={4096}
                value={key}
                onChange={(e) => setKey(e.target.value)}
              />
            </label>
            <button
              className="btn primary"
              disabled={credentials.isPending || !data.data?.secretStorageConfigured}
            >
              {credentials.isPending ? "Saving…" : "Save credentials"}
            </button>
            {credentials.isSuccess && (
              <p role="status">Credentials saved. Test a route below to verify the connection.</p>
            )}
            <ErrorNotice error={credentials.error || remove.error} />
          </form>
        </section>
        <section className="connected-panel">
          <div className="integration-row">
            <h2>Model routes</h2>
            <button className="btn" onClick={() => setEditing(null)}>
              Create route
            </button>
          </div>
          <div className="compact-stack">
            {data.data?.routes.map((r) => (
              <article className="integration-row" key={r.id}>
                <div>
                  <strong>{r.name}</strong>
                  <p className="hint">
                    {(JSON.parse(r.config_json) as ModelRouteConfig).models
                      .map((m) => m.provider + " / " + m.model)
                      .join(" → ")}
                  </p>
                </div>
                <div className="actions">
                  <button className="btn" onClick={() => setEditing(r)}>
                    Edit
                  </button>
                  <button
                    className="btn"
                    disabled={delRoute.isPending}
                    onClick={() => delRoute.mutate(r.id)}
                  >
                    Delete
                  </button>
                </div>
              </article>
            ))}
            {data.data?.routes.length === 0 && (
              <p>Create your first route to choose a model and its fallback.</p>
            )}
          </div>
          <ErrorNotice error={delRoute.error} />
        </section>
      </div>
      {editing !== undefined && (
        <RouteEditor
          key={editing?.id ?? "new"}
          record={editing}
          project={p}
          close={() => setEditing(undefined)}
          saved={() => {
            setEditing(undefined);
            void refresh();
          }}
        />
      )}
      <section className="connected-panel section">
        <h2>Test a route</h2>
        <form
          className="form-stack"
          onSubmit={(e) => {
            e.preventDefault();
            play.mutate();
          }}
        >
          <label>
            Route
            <select required value={route} onChange={(e) => setRoute(e.target.value)}>
              <option value="">Choose a route</option>
              {data.data?.routes.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Prompt
            <textarea
              required
              maxLength={10000}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={4}
            />
          </label>
          <button className="btn primary" disabled={play.isPending}>
            {play.isPending ? "Waiting for provider…" : "Send request"}
          </button>
          <ErrorNotice error={play.error} />
        </form>
        {play.data && (
          <div className="section">
            <Data value={play.data.text} />
            <p className="hint">
              {play.data.provider} · {play.data.model} · {play.data.durationMs}ms · Input tokens{" "}
              {play.data.inputTokens ?? "unreported"} · Output tokens{" "}
              {play.data.outputTokens ?? "unreported"}
            </p>
            <p className="hint">
              {play.data.estimatedCostUsd === null
                ? "Cost unavailable — add model rates to estimate."
                : "Estimated cost $" + play.data.estimatedCostUsd.toFixed(6)}
            </p>
          </div>
        )}
      </section>
      <section className="connected-panel section">
        <h2>Request history</h2>
        <div className="compact-stack">
          {data.data?.requests.map((r) => (
            <article key={r.id}>
              <div className="integration-row">
                <strong>{r.model ?? r.id}</strong>
                <Badge status={r.status} />
              </div>
              <p className="hint">
                {new Date(r.created_at).toLocaleString()} · {r.duration_ms}ms ·{" "}
                {r.input_tokens ?? "—"} input / {r.output_tokens ?? "—"} output tokens
              </p>
              <p className="hint">
                {(
                  JSON.parse(r.attempts_json) as {
                    provider: string;
                    model: string;
                    status: string;
                  }[]
                )
                  .map((a) => `${a.provider} / ${a.model}: ${a.status}`)
                  .join(" → ")}
              </p>
            </article>
          ))}
          {data.data?.requests.length === 0 && <p>No requests yet.</p>}
        </div>
      </section>
    </>
  );
}
function RouteEditor({
  project: p,
  record,
  close,
  saved,
}: {
  project: string;
  record: RouteRecord | null;
  close: () => void;
  saved: () => void;
}) {
  const [config, setConfig] = useState<ModelRouteConfig>(() =>
    record
      ? JSON.parse(record.config_json)
      : { name: "", models: [{ provider: "groq", model: "" }], timeoutMs: 15000, maxTokens: 1000 },
  );
  const save = useMutation({
    mutationFn: () => {
      const parsed = modelRouteSchema.safeParse(config);
      if (!parsed.success) throw new Error("Enter a route name, model name, and valid limits.");
      return request(
        p,
        "gateway/routes" + (record ? "/" + record.id : ""),
        record ? "PUT" : "POST",
        record ? { revision: record.revision, config: parsed.data } : parsed.data,
      );
    },
    onSuccess: saved,
  });
  return (
    <section className="connected-panel section">
      <h2>{record ? "Edit route" : "Create route"}</h2>
      <form
        className="form-stack"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <label>
          Route name
          <input
            required
            maxLength={80}
            value={config.name}
            onChange={(e) => setConfig({ ...config, name: e.target.value })}
          />
        </label>
        {config.models.map((m, i) => (
          <fieldset className="route-target" key={i}>
            <legend>{i === 0 ? "Primary model" : "Fallback " + i}</legend>
            <div className="form-grid">
              <label>
                Provider
                <select
                  value={m.provider}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      models: config.models.map((v, j) =>
                        j === i ? { ...v, provider: e.target.value as typeof m.provider } : v,
                      ),
                    })
                  }
                >
                  <option value="groq">Groq</option>
                  <option value="openai">OpenAI</option>
                  <option value="workers">Workers AI</option>
                </select>
              </label>
              <label>
                Model identifier
                <input
                  required
                  maxLength={150}
                  value={m.model}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      models: config.models.map((v, j) =>
                        j === i ? { ...v, model: e.target.value } : v,
                      ),
                    })
                  }
                />
              </label>
              {(["inputPricePerMillion", "outputPricePerMillion"] as const).map((field) => (
                <label key={field}>
                  {field === "inputPricePerMillion" ? "Input" : "Output"} USD / million tokens
                  (optional)
                  <input
                    type="number"
                    min="0"
                    max="10000"
                    step="any"
                    value={m[field] ?? ""}
                    onChange={(e) =>
                      setConfig({
                        ...config,
                        models: config.models.map((v, j) =>
                          j === i
                            ? {
                                ...v,
                                [field]: e.target.value === "" ? undefined : Number(e.target.value),
                              }
                            : v,
                        ),
                      })
                    }
                  />
                </label>
              ))}
            </div>
            {i > 0 && (
              <button
                type="button"
                className="btn"
                onClick={() =>
                  setConfig({ ...config, models: config.models.filter((_, j) => i !== j) })
                }
              >
                Remove fallback
              </button>
            )}
          </fieldset>
        ))}
        <div className="actions">
          {config.models.length < 3 && (
            <button
              type="button"
              className="btn"
              onClick={() =>
                setConfig({
                  ...config,
                  models: [...config.models, { provider: "openai", model: "" }],
                })
              }
            >
              Add fallback
            </button>
          )}
        </div>
        <div className="form-grid">
          <label>
            Timeout per attempt (ms)
            <input
              type="number"
              required
              min="1000"
              max="30000"
              value={config.timeoutMs}
              onChange={(e) => setConfig({ ...config, timeoutMs: Number(e.target.value) })}
            />
          </label>
          <label>
            Maximum output tokens
            <input
              type="number"
              required
              min="1"
              max="4096"
              value={config.maxTokens}
              onChange={(e) => setConfig({ ...config, maxTokens: Number(e.target.value) })}
            />
          </label>
        </div>
        <p className="hint">
          Fallbacks run after a timeout, rate limit or provider server failure. Rates are your
          configured estimates, not billed charges.
        </p>
        <div className="actions">
          <button type="button" className="btn" onClick={close}>
            Cancel
          </button>
          <button className="btn primary" disabled={save.isPending}>
            {save.isPending ? "Saving…" : "Save route"}
          </button>
        </div>
        <ErrorNotice error={save.error} />
      </form>
    </section>
  );
}
export function Approvals({ projectId: p }: { projectId: string }) {
  const cache = useQueryClient(),
    q = useQuery({
      queryKey: ["approvals", p],
      queryFn: () => integrations.approvals(p),
      refetchInterval: 3000,
    }),
    [note, setNote] = useState<Record<string, string>>({});
  const decision = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      request(p, "approvals/" + id + "/decision", "POST", {
        decision: status,
        note: note[id] ?? "",
      }),
    onSuccess: () => cache.invalidateQueries({ queryKey: ["approvals", p] }),
  });
  return (
    <>
      <Title title="Approvals">
        Review a waiting step. Your decision resumes or stops its execution.
      </Title>
      <Wait loading={q.isPending} error={q.error} />
      <ErrorNotice error={decision.error} />
      <div className="compact-stack">
        {q.data?.items.map((a) => (
          <section className="connected-panel" key={a.id}>
            <div className="integration-row">
              <h2>{a.prompt}</h2>
              <Badge status={a.status} />
            </div>
            <Link className="text-link" to={"/executions/" + a.run_id}>
              Open execution
            </Link>
            <Data value={JSON.parse(a.payload_json)} />
            {a.status === "PENDING" ? (
              <>
                <label>
                  Review note
                  <textarea
                    maxLength={1000}
                    value={note[a.id] ?? ""}
                    onChange={(e) => setNote({ ...note, [a.id]: e.target.value })}
                  />
                </label>
                <p className="hint">Expires {new Date(a.expires_at).toLocaleString()}</p>
                <div className="actions section">
                  <button
                    className="btn"
                    disabled={decision.isPending}
                    onClick={() => decision.mutate({ id: a.id, status: "REJECTED" })}
                  >
                    Reject
                  </button>
                  <button
                    className="btn primary"
                    disabled={decision.isPending}
                    onClick={() => decision.mutate({ id: a.id, status: "APPROVED" })}
                  >
                    Approve
                  </button>
                </div>
              </>
            ) : (
              a.decision_note && <p>{a.decision_note}</p>
            )}
          </section>
        ))}
        {q.data?.items.length === 0 && (
          <section className="connected-panel">
            <h2>Nothing waiting for review</h2>
            <p>Add an Approval step in Studio to review its input before execution continues.</p>
            <Link className="btn section" to="/workflows">
              Open workflows
            </Link>
          </section>
        )}
      </div>
    </>
  );
}
export function Traces({ projectId: p }: { projectId: string }) {
  return (
    <>
      <Title title="Runtime traces">
        Recorded executions from this project, with their steps and failures.
      </Title>
      <ProjectActivity projectId={p} />
    </>
  );
}
export function Developer({ projectId: p }: { projectId: string }) {
  const cache = useQueryClient(),
    q = useQuery({ queryKey: ["keys", p], queryFn: () => integrations.keys(p) }),
    [name, setName] = useState(""),
    [scopes, setScopes] = useState(["traces:write"]),
    [token, setToken] = useState(""),
    [copied, setCopied] = useState(false);
  const create = useMutation({
      mutationFn: () => request<{ token: string }>(p, "keys", "POST", { name, scopes }),
      onSuccess: (r) => {
        setToken(r.token);
        setName("");
        void cache.invalidateQueries({ queryKey: ["keys", p] });
      },
    }),
    revoke = useMutation({
      mutationFn: (id: string) => request(p, "keys/" + id + "/revoke", "POST"),
      onSuccess: () => cache.invalidateQueries({ queryKey: ["keys", p] }),
    });
  const origin = window.location.origin;
  return (
    <>
      <Title title="API keys & SDK">
        Connect a server, send traces, or launch an execution over HTTP.
      </Title>
      <section className="connected-panel">
        <h2>Project API keys</h2>
        <Wait loading={q.isPending} error={q.error} />
        <div className="compact-stack">
          {q.data?.items.map((k) => (
            <article className="integration-row" key={k.id}>
              <div>
                <strong>{k.name}</strong>
                <p className="hint">
                  {k.prefix}… · {JSON.parse(k.scopes_json).join(", ")} ·{" "}
                  {k.revoked_at
                    ? "Revoked"
                    : "Expires " + new Date(k.expires_at).toLocaleDateString()}
                </p>
              </div>
              <button
                className="btn"
                disabled={!!k.revoked_at || revoke.isPending}
                onClick={() => revoke.mutate(k.id)}
              >
                Revoke
              </button>
            </article>
          ))}
        </div>
        <form
          className="form-stack section"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <label>
            Key name
            <input required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <fieldset className="scope-options">
            <legend>Permissions</legend>
            {["traces:write", "runs:read", "runs:write"].map((s) => (
              <label key={s}>
                <input
                  type="checkbox"
                  checked={scopes.includes(s)}
                  onChange={(e) =>
                    setScopes(e.target.checked ? [...scopes, s] : scopes.filter((v) => v !== s))
                  }
                />
                {s}
              </label>
            ))}
          </fieldset>
          <button className="btn primary" disabled={!scopes.length || create.isPending}>
            Create key
          </button>
          <ErrorNotice error={create.error || revoke.error} />
        </form>
        {token && (
          <div className="secret-reveal section">
            <h3>Copy your key now</h3>
            <p>It is shown once. Keep it on your server.</p>
            <code>{token}</code>
            <div className="actions section">
              <button
                className="btn"
                onClick={() => {
                  void navigator.clipboard
                    .writeText(token)
                    .then(() => setCopied(true))
                    .catch(() => setCopied(false));
                }}
              >
                {copied ? "Copied" : "Copy key"}
              </button>
              <button
                className="btn"
                onClick={() => {
                  setToken("");
                  setCopied(false);
                }}
              >
                Done
              </button>
            </div>
          </div>
        )}
      </section>
      <section className="connected-panel section">
        <h2>TypeScript instrumentation</h2>
        <p>
          Copy{" "}
          <a
            className="text-link"
            href="https://github.com/fysaio/traceyard/blob/integration/real-auth-workflows/sdk/client.ts"
            target="_blank"
            rel="noreferrer"
          >
            sdk/client.ts
          </a>{" "}
          from this repository into your server project. Requires a runtime with fetch and Web
          Crypto. Store TRACEYARD_KEY in your server environment.
        </p>
        <Data
          value={`import { TraceyardClient } from './client';\nconst traceyard = new TraceyardClient({\n  origin: '${origin}',\n  apiKey: process.env.TRACEYARD_KEY!\n});\nawait traceyard.span('Process order', async (parent) => {\n  return traceyard.span('Validate order', async () => {\n    return validateOrder();\n  }, { parent, kind: 'step' });\n}, { kind: 'workflow' });`}
        />
        <p className="hint">
          Pass the parent context to nested operations. Input and output payloads are opt-in through
          attributes; secret field names and common tokens are redacted on ingestion. Review custom
          attributes before sending them.
        </p>
        <h3 className="section">HTTP execution trigger</h3>
        <Data
          value={`curl '${origin}/api/v1/runs' \\\n  -H "Authorization: Bearer $TRACEYARD_KEY" \\\n  -H 'Content-Type: application/json' \\\n  -H 'Idempotency-Key: order-00001' \\\n  -d '{"workflowId":"YOUR_PUBLISHED_WORKFLOW_ID","version":1,"input":{},"scenario":"success"}'`}
        />
        <p className="hint">
          Keys are project scoped, expire after 90 days, and allow 120 requests per minute. Use
          runs:write to launch/cancel and runs:read to inspect. GET /api/v1/runs lists executions;
          GET /api/v1/runs/:id reads one.
        </p>
      </section>
    </>
  );
}
export function Automations({ projectId: p }: { projectId: string }) {
  const cache = useQueryClient(),
    q = useQuery({
      queryKey: ["automations", p],
      queryFn: () => integrations.automations(p),
      refetchInterval: 10000,
    }),
    workflows = useQuery({ queryKey: ["workflows", p], queryFn: () => api.workflows(p) }),
    [workflow, setWorkflow] = useState(""),
    [version, setVersion] = useState(1),
    [input, setInput] = useState("{}"),
    [interval, setInterval] = useState(60),
    [url, setUrl] = useState(""),
    [secret, setSecret] = useState("");
  const refresh = () => cache.invalidateQueries({ queryKey: ["automations", p] }),
    schedule = useMutation({
      mutationFn: () =>
        request(p, "schedules", "POST", {
          workflowId: workflow,
          version,
          input: inputJson(input),
          intervalMinutes: interval,
        }),
      onSuccess: refresh,
    }),
    webhook = useMutation({
      mutationFn: () => request(p, "webhooks", "POST", { url, signingSecret: secret }),
      onSuccess: () => {
        setSecret("");
        setUrl("");
        void refresh();
      },
    }),
    change = useMutation({
      mutationFn: ({
        resource,
        id,
        enabled,
      }: {
        resource: string;
        id: string;
        enabled?: boolean;
      }) =>
        request(
          p,
          resource + "/" + id,
          enabled === undefined ? "DELETE" : "PUT",
          enabled === undefined ? undefined : { enabled },
        ),
      onSuccess: refresh,
    });
  return (
    <>
      <Title title="Schedules & webhooks">
        Schedule published workflows and deliver completion events to your systems.
      </Title>
      <Wait loading={q.isPending} error={q.error} />
      <ErrorNotice error={change.error} />
      <div className="integration-columns">
        <section className="connected-panel">
          <h2>Schedules</h2>
          <div className="compact-stack">
            {q.data?.schedules.map((s) => (
              <article key={s.id}>
                <div className="integration-row">
                  <strong>
                    {workflows.data?.find((w) => w.id === s.workflow_id)?.name ?? s.workflow_id} · v
                    {s.workflow_version}
                  </strong>
                  <Badge status={s.enabled ? "RUNNING" : "PAUSED"} />
                </div>
                <p className="hint">
                  Every {s.interval_minutes} minutes · Next{" "}
                  {new Date(s.next_run_at).toLocaleString()}
                </p>
                {s.last_run_id && (
                  <Link className="text-link" to={"/executions/" + s.last_run_id}>
                    Last execution
                  </Link>
                )}
                {s.last_error && <ErrorNotice error={new Error(s.last_error)} />}
                <div className="actions section">
                  <button
                    className="btn"
                    disabled={change.isPending}
                    onClick={() =>
                      change.mutate({ resource: "schedules", id: s.id, enabled: !s.enabled })
                    }
                  >
                    {s.enabled ? "Pause" : "Resume"}
                  </button>
                  <button
                    className="btn"
                    disabled={change.isPending}
                    onClick={() => change.mutate({ resource: "schedules", id: s.id })}
                  >
                    Delete
                  </button>
                </div>
              </article>
            ))}
          </div>
          <form
            className="form-stack section"
            onSubmit={(e) => {
              e.preventDefault();
              schedule.mutate();
            }}
          >
            <label>
              Published workflow
              <select
                required
                value={workflow}
                onChange={(e) => {
                  setWorkflow(e.target.value);
                  setVersion(workflows.data?.find((w) => w.id === e.target.value)?.version ?? 1);
                }}
              >
                <option value="">Choose a workflow</option>
                {workflows.data?.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="form-grid">
              <label>
                Version
                <input
                  type="number"
                  required
                  min="1"
                  value={version}
                  onChange={(e) => setVersion(Number(e.target.value))}
                />
              </label>
              <label>
                Interval (minutes)
                <input
                  type="number"
                  required
                  min="5"
                  max="10080"
                  value={interval}
                  onChange={(e) => setInterval(Number(e.target.value))}
                />
              </label>
            </div>
            <label>
              Input JSON
              <textarea
                rows={5}
                required
                value={input}
                onChange={(e) => setInput(e.target.value)}
              />
            </label>
            <p className="hint">
              The five-minute scheduler starts the selected published version. Pausing prevents
              future launches.
            </p>
            <button className="btn primary" disabled={schedule.isPending}>
              Create schedule
            </button>
            <ErrorNotice error={schedule.error || workflows.error} />
          </form>
        </section>
        <section className="connected-panel">
          <h2>Completion webhooks</h2>
          <div className="compact-stack">
            {q.data?.webhooks.map((w) => (
              <article key={w.id}>
                <strong className="wrap-anywhere">{w.url}</strong>
                <p className="hint">{w.enabled ? "Enabled" : "Paused"}</p>
                <div className="actions section">
                  <button
                    className="btn"
                    disabled={change.isPending}
                    onClick={() =>
                      change.mutate({ resource: "webhooks", id: w.id, enabled: !w.enabled })
                    }
                  >
                    {w.enabled ? "Pause" : "Resume"}
                  </button>
                  <button
                    className="btn"
                    disabled={change.isPending}
                    onClick={() => change.mutate({ resource: "webhooks", id: w.id })}
                  >
                    Delete
                  </button>
                </div>
              </article>
            ))}
          </div>
          <form
            className="form-stack section"
            onSubmit={(e) => {
              e.preventDefault();
              webhook.mutate();
            }}
          >
            <label>
              Destination URL
              <input type="url" required value={url} onChange={(e) => setUrl(e.target.value)} />
            </label>
            <label>
              Signing secret
              <input
                type="password"
                autoComplete="off"
                minLength={24}
                maxLength={200}
                required
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
              />
            </label>
            <p className="hint">
              Allowed hosts:{" "}
              {q.data?.allowedHosts.join(", ") ||
                "None configured. Set OUTBOUND_ALLOWED_HOSTS on the Worker."}
            </p>
            <button
              className="btn primary"
              disabled={webhook.isPending || !q.data?.allowedHosts.length}
            >
              Create webhook
            </button>
            <ErrorNotice error={webhook.error} />
          </form>
        </section>
      </div>
      <section className="connected-panel section">
        <h2>Deliveries</h2>
        <p className="hint">
          Completion events are signed with HMAC-SHA256 over timestamp + "." + the exact request
          body. Verify X-Traceyard-Timestamp and X-Traceyard-Signature. Deduplicate
          X-Traceyard-Delivery. Failed requests retry up to five times.
        </p>
        <div className="compact-stack section">
          {q.data?.deliveries.map((d) => (
            <article key={d.id}>
              <div className="integration-row">
                <Link to={"/executions/" + d.run_id}>Open execution</Link>
                <Badge status={d.status} />
              </div>
              <p className="hint">
                {d.attempts} attempts · HTTP {d.response_status ?? "—"} · {d.id}
              </p>
              {d.last_error && <p>{d.last_error}</p>}
            </article>
          ))}
          {q.data?.deliveries.length === 0 && <p>No deliveries yet.</p>}
        </div>
      </section>
    </>
  );
}
export function Experiments({ projectId: p }: { projectId: string }) {
  const cache = useQueryClient(),
    q = useQuery({
      queryKey: ["experiments", p],
      queryFn: () => integrations.experiments(p),
      refetchInterval: 3000,
    }),
    workflows = useQuery({ queryKey: ["workflows", p], queryFn: () => api.workflows(p) }),
    [name, setName] = useState(""),
    [config, setConfig] = useState<ExperimentConfig>({
      workflowId: "",
      version: 1,
      input: {},
      scenario: "success",
      repetitions: 1,
      expectedStatus: "SUCCEEDED",
      outputPath: "",
    }),
    [input, setInput] = useState("{}"),
    [assertOutput, setAssertOutput] = useState(false),
    [expected, setExpected] = useState("null"),
    [maxDuration, setMaxDuration] = useState(""),
    [show, setShow] = useState(false);
  const refresh = () => cache.invalidateQueries({ queryKey: ["experiments", p] }),
    create = useMutation({
      mutationFn: () =>
        request<{ id: string }>(p, "experiments", "POST", {
          name,
          config: {
            ...config,
            input: inputJson(input),
            ...(assertOutput ? { expectedValue: inputJson(expected) } : {}),
            ...(maxDuration ? { maxDurationMs: Number(maxDuration) } : {}),
          },
        }),
      onSuccess: () => {
        setShow(false);
        setName("");
        void refresh();
      },
    }),
    launch = useMutation({
      mutationFn: (id: string) => request(p, "experiments/" + id + "/launch", "POST"),
      onSuccess: refresh,
    });
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Workflow experiments</h1>
          <p>Run a repeatable check against a published workflow and inspect the evidence.</p>
        </div>
        <button
          className={show ? "btn" : "btn primary"}
          aria-expanded={show}
          onClick={() => setShow(!show)}
        >
          {show ? "Hide experiment form" : "Create experiment"}
          <Icon name={show ? "chevron-up" : "chevron-down"} />
        </button>
      </div>
      <Wait loading={q.isPending} error={q.error} />
      <ErrorNotice error={launch.error} />
      {show && (
        <section className="connected-panel">
          <h2>Define experiment</h2>
          <form
            className="form-stack"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate();
            }}
          >
            <label>
              Name
              <input
                required
                maxLength={100}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label>
              Workflow
              <select
                required
                value={config.workflowId}
                onChange={(e) =>
                  setConfig({
                    ...config,
                    workflowId: e.target.value,
                    version: workflows.data?.find((w) => w.id === e.target.value)?.version ?? 1,
                    scenario: "success",
                  })
                }
              >
                <option value="">Choose a workflow</option>
                {workflows.data?.map((w) => (
                  <option value={w.id} key={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="form-grid">
              <label>
                Published version
                <input
                  required
                  type="number"
                  min="1"
                  value={config.version}
                  onChange={(e) => setConfig({ ...config, version: Number(e.target.value) })}
                />
              </label>
              <label>
                Repetitions
                <input
                  required
                  type="number"
                  min="1"
                  max="5"
                  value={config.repetitions}
                  onChange={(e) => setConfig({ ...config, repetitions: Number(e.target.value) })}
                />
              </label>
            </div>
            <label>
              Input JSON
              <textarea
                rows={6}
                required
                value={input}
                onChange={(e) => setInput(e.target.value)}
              />
            </label>
            {workflows.data?.find((w) => w.id === config.workflowId)?.slug ===
              "document-intelligence" && (
              <label>
                Controlled fault
                <select
                  value={config.scenario}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      scenario: e.target.value as ExperimentConfig["scenario"],
                    })
                  }
                >
                  <option value="success">None</option>
                  <option value="retryable_failure">Retryable extraction failure</option>
                  <option value="permanent_failure">Permanent extraction failure</option>
                </select>
              </label>
            )}
            <div className="form-grid">
              <label>
                Expected result
                <select
                  value={config.expectedStatus}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      expectedStatus: e.target.value as ExperimentConfig["expectedStatus"],
                    })
                  }
                >
                  <option>SUCCEEDED</option>
                  <option>FAILED</option>
                  <option>CANCELLED</option>
                </select>
              </label>
              <label>
                Maximum duration ms (optional)
                <input
                  type="number"
                  min="1"
                  max="3600000"
                  value={maxDuration}
                  onChange={(e) => setMaxDuration(e.target.value)}
                />
              </label>
            </div>
            <label className="check-label">
              <input
                type="checkbox"
                checked={assertOutput}
                onChange={(e) => setAssertOutput(e.target.checked)}
              />
              Check an output value
            </label>
            {assertOutput && (
              <>
                <label>
                  Output field path (leave blank for entire output)
                  <input
                    value={config.outputPath}
                    onChange={(e) => setConfig({ ...config, outputPath: e.target.value })}
                  />
                </label>
                <label>
                  Expected JSON value
                  <textarea
                    rows={3}
                    value={expected}
                    onChange={(e) => setExpected(e.target.value)}
                  />
                </label>
              </>
            )}
            <div className="actions">
              <button type="button" className="btn" onClick={() => setShow(false)}>
                Cancel
              </button>
              <button className="btn primary" disabled={create.isPending}>
                Save experiment
              </button>
            </div>
            <ErrorNotice error={create.error || workflows.error} />
          </form>
        </section>
      )}
      <div className="compact-stack section">
        {q.data?.items.map((e) => (
          <section className="connected-panel" key={e.id}>
            <div className="integration-row">
              <div>
                <h2>{e.name}</h2>
                <p className="hint">
                  Version {e.config.version} · {e.config.repetitions} repetitions · Expect{" "}
                  {e.config.expectedStatus.toLowerCase()}
                </p>
              </div>
              {e.runs.length < e.config.repetitions && (
                <button
                  className="btn primary"
                  disabled={launch.isPending}
                  onClick={() => launch.mutate(e.id)}
                >
                  {e.runs.length ? "Continue launches" : "Run experiment"}
                </button>
              )}
            </div>
            <div className="compact-stack section">
              {e.runs.map((r) => (
                <article key={r.id}>
                  <div className="integration-row">
                    <Link className="text-link" to={"/executions/" + r.id}>
                      Trial {r.ordinal}
                    </Link>
                    <Badge status={r.status} />
                    <Badge status={r.verdict.status} />
                  </div>
                  {r.verdict.checks.map((c) => (
                    <p className="hint" key={c.name}>
                      {c.passed ? "Pass" : "Fail"} · {c.name}
                    </p>
                  ))}
                </article>
              ))}
            </div>
            {e.runs.length > 1 && (
              <Link
                className="btn section"
                to={"/compare?left=" + e.runs[0]!.id + "&right=" + e.runs[1]!.id}
              >
                Compare executions
              </Link>
            )}
          </section>
        ))}
        {q.data?.items.length === 0 && (
          <section className="connected-panel">
            <h2>No experiments yet</h2>
            <p>Create a check, run it, and compare actual outputs and timing.</p>
          </section>
        )}
      </div>
    </>
  );
}
