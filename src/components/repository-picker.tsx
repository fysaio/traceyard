import { useState } from "react";
import { ErrorMessage, Icon } from "./product-ui";

export interface RepositoryChoice {
  id: number;
  name: string;
  installationId: number;
}

export interface RepositoryChoices {
  configured: boolean;
  installationCount?: number;
  manageUrl?: string | null;
  installUrl: string | null;
  items: RepositoryChoice[];
}

export function RepositoryPicker({
  data,
  loading,
  refreshing,
  error,
  connectingId,
  onConnect,
  onRefresh,
  onLocal,
}: {
  data?: RepositoryChoices;
  loading: boolean;
  refreshing: boolean;
  error: unknown;
  connectingId?: number;
  onConnect: (repository: RepositoryChoice) => void;
  onRefresh: () => void;
  onLocal: () => void;
}) {
  const [search, setSearch] = useState("");
  const installed = !!data && ((data.installationCount ?? 0) > 0 || data.items.length > 0);
  const items =
    data?.items.filter((r) => r.name.toLowerCase().includes(search.trim().toLowerCase())) ?? [];

  return (
    <div className="repository-picker">
      <p className="repository-intro">Choose a repo to create or open its Traceyard project.</p>
      <ErrorMessage error={error} />
      {loading ? (
        <div className="repository-empty" role="status">
          <Icon name="circle-notch" />
          <p>Finding your repositories…</p>
        </div>
      ) : !data ? (
        <div className="repository-empty">
          <p>Your repositories could not load.</p>
          <button className="btn" disabled={refreshing} onClick={onRefresh}>
            Try again
          </button>
        </div>
      ) : !data.configured ? (
        <div className="repository-empty">
          <h3>GitHub connection needs server setup</h3>
          <p>Configure the GitHub App credentials before connecting a repo.</p>
          <a className="text-link" href="/repository-setup">
            Deployment setup instructions
          </a>
        </div>
      ) : (
        <>
          {data.items.length > 0 && (
            <input
              className="repository-search"
              type="search"
              aria-label="Find a repository"
              placeholder="Find a repo…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          )}
          {items.length > 0 ? (
            <div className="repository-choices" role="group" aria-label="GitHub repositories">
              {items.map((r) => (
                <button
                  key={r.id}
                  className="repository-choice"
                  aria-label={"Connect " + r.name}
                  aria-busy={connectingId === r.id}
                  disabled={connectingId !== undefined}
                  onClick={() => onConnect(r)}
                >
                  <i className="fa-brands fa-github" aria-hidden="true" />
                  <strong>{r.name}</strong>
                  <span>{connectingId === r.id ? "Connecting…" : "Connect"}</span>
                  <Icon name={connectingId === r.id ? "circle-notch" : "arrow-right"} />
                </button>
              ))}
            </div>
          ) : (
            <div className="repository-empty">
              <i className="fa-brands fa-github" aria-hidden="true" />
              <h3>
                {data.items.length
                  ? "No matching repos"
                  : installed
                    ? "No repos shared yet"
                    : "Connect GitHub once"}
              </h3>
              <p>
                {data.items.length
                  ? "Try a different name."
                  : installed
                    ? "Choose which repositories Traceyard can access, then refresh."
                    : "Select the repositories you want Traceyard to access on GitHub."}
              </p>
            </div>
          )}
          <div className="repository-actions">
            {!installed && data.installUrl && (
              <a className="btn primary" href={data.installUrl} target="_blank" rel="noreferrer">
                <i className="fa-brands fa-github" aria-hidden="true" /> Install Traceyard
              </a>
            )}
            <button
              className="btn"
              disabled={refreshing || connectingId !== undefined}
              onClick={onRefresh}
            >
              <Icon name={refreshing ? "circle-notch" : "rotate-right"} />
              {refreshing ? "Refreshing…" : "Refresh repos"}
            </button>
            {installed && data.manageUrl && (
              <a className="btn quiet" href={data.manageUrl} target="_blank" rel="noreferrer">
                Manage access
              </a>
            )}
          </div>
        </>
      )}
      <button className="text-link repository-local" onClick={onLocal}>
        Connect a local project instead
      </button>
    </div>
  );
}
