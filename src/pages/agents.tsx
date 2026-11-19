import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CopyButton,
  ErrorMessage,
  Icon,
  Modal,
  PageHeader,
  Spinner,
  formatTime,
} from "../components/ui";
import { useWorkspace } from "../lib/workspace";
import { integrationRequest } from "../lib/integrations-api";

interface Grant {
  id: string;
  name: string;
  scopes_json: string;
  created_at: string;
  revoked_at: string | null;
}

const CLIENTS = [
  ["chatgpt", "ChatGPT"],
  ["antigravity", "Antigravity"],
  ["other", "Other MCP client"],
] as const;

const SCOPES: Record<string, string> = {
  "investigations:read": "Read evidence",
  "investigations:run": "Run tests",
};

export function AgentsPage() {
  const { projectId, projects } = useWorkspace(),
    cache = useQueryClient();
  const [client, setClient] = useState<(typeof CLIENTS)[number][0]>("chatgpt"),
    [revokeTarget, setRevokeTarget] = useState<Grant | null>(null);
  const project = projects.find((p) => p.id === projectId),
    endpoint = window.location.origin + "/mcp";
  const antigravitySetup = `Add a remote MCP server named traceyard to my Antigravity global MCP configuration. Use serverUrl ${endpoint}. Preserve every existing server and setting. The configuration is at ~/.gemini/config/mcp_config.json (under USERPROFILE on Windows). Save the configuration, then tell me how to reload the server and click Authenticate in Customizations > Installed > MCP Servers. Traceyard connects the account first. When I need a repository, show the Traceyard link where I can allow access to that project. Let me complete browser consent and any authorization-code entry myself.`;
  const grants = useQuery({
    queryKey: ["agent-connections", projectId],
    queryFn: () => integrationRequest<{ items: Grant[] }>(projectId, "agent-connections"),
    enabled: !!projectId,
    refetchOnWindowFocus: true,
    refetchInterval: (q) => (q.state.data?.items.some((g) => !g.revoked_at) ? false : 15000),
  });
  const revoke = useMutation({
    mutationFn: (id: string) =>
      integrationRequest(
        projectId,
        `agent-connections/${encodeURIComponent(id)}/revoke`,
        "POST",
        {},
      ),
    onSuccess: () => {
      setRevokeTarget(null);
      void cache.invalidateQueries({ queryKey: ["agent-connections", projectId] });
    },
  });

  return (
    <div className="page">
      <PageHeader
        title="Agents"
        description="Let your coding agent reproduce the failure and prove its fix before you review the change."
      />
      <div className="stack-xl">
        <section className="card stack">
          <div className="section-head">
            <h2>Connect an agent</h2>
            <a className="text-link" href="/oauth/connections">
              Manage access
            </a>
          </div>
          <div className="segmented" role="group" aria-label="Coding agent">
            {CLIENTS.map(([value, label]) => (
              <button
                type="button"
                key={value}
                aria-pressed={client === value}
                onClick={() => setClient(value)}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="inline-field">
            <code className="endpoint">{endpoint}</code>
            <CopyButton value={endpoint} label="Copy URL" />
          </div>
          {client === "chatgpt" ? (
            <ol className="steps">
              <li>
                In ChatGPT, open <strong>Plugins → + → Add custom MCP server</strong>.
              </li>
              <li>
                Name it <strong>Traceyard</strong>, paste the URL and choose <strong>OAuth</strong>.
              </li>
              <li>
                Finish signing in. Select <strong>@Traceyard</strong> and ask it to look at your
                repository. It sends a link when it needs access to a project.
              </li>
            </ol>
          ) : client === "antigravity" ? (
            <>
              <ol className="steps">
                <li>Copy the setup request below and paste it into Antigravity.</li>
                <li>
                  Open <strong>Customizations → Installed → MCP Servers</strong> and choose{" "}
                  <strong>Authenticate</strong> for Traceyard.
                </li>
                <li>Finish signing in. If asked, paste the callback code into Antigravity.</li>
              </ol>
              <div>
                <CopyButton value={antigravitySetup} label="Copy setup request" />
              </div>
            </>
          ) : (
            <ol className="steps">
              <li>Add a remote HTTP MCP server with the URL above.</li>
              <li>Choose OAuth and finish signing in. Allow a project when asked.</li>
              <li>
                Ask your agent to call <code>inspect</code> with <code>section: capabilities</code>{" "}
                first.
              </li>
            </ol>
          )}
          <p className="muted">
            No API key needed. Your client must support remote MCP with OAuth.
          </p>
        </section>

        {project && (
          <section className="stack">
            <div className="section-head">
              <h2 className="section-title">Access to {project.repository ?? project.name}</h2>
              <button
                className="btn ghost"
                disabled={grants.isFetching}
                onClick={() => void grants.refetch()}
              >
                <Icon name={grants.isFetching ? "spinner" : "refresh"} />
                Refresh
              </button>
            </div>
            {grants.isPending ? (
              <Spinner label="Loading agents…" />
            ) : grants.isError ? (
              <ErrorMessage error={grants.error} />
            ) : grants.data.items.length ? (
              <div className="list">
                {grants.data.items.map((g) => (
                  <div className="row" key={g.id}>
                    <Icon name="agent" />
                    <div className="row-main">
                      <strong className="truncate">{g.name}</strong>
                      <span className="muted truncate">
                        {(JSON.parse(g.scopes_json) as string[])
                          .filter((scope) => SCOPES[scope])
                          .map((scope) => SCOPES[scope])
                          .join(" · ")}
                        {" · Added "}
                        {formatTime(g.created_at)}
                      </span>
                    </div>
                    {g.revoked_at ? (
                      <span className="muted">Revoked</span>
                    ) : (
                      <button
                        className="btn"
                        onClick={() => {
                          revoke.reset();
                          setRevokeTarget(g);
                        }}
                      >
                        Revoke
                      </button>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className="muted">
                No agent has access yet. Connect one above, then allow this repository when it asks.
              </p>
            )}
          </section>
        )}
      </div>
      {revokeTarget && (
        <Modal
          title="Revoke access?"
          close={() => setRevokeTarget(null)}
          footer={
            <>
              <button className="btn" onClick={() => setRevokeTarget(null)}>
                Keep access
              </button>
              <button
                className="btn danger"
                disabled={revoke.isPending}
                onClick={() => revoke.mutate(revokeTarget.id)}
              >
                {revoke.isPending ? "Revoking…" : "Revoke"}
              </button>
            </>
          }
        >
          <p>
            {revokeTarget.name} will lose access to this repository. You can allow it again later.
          </p>
          <ErrorMessage error={revoke.error} />
        </Modal>
      )}
    </div>
  );
}
