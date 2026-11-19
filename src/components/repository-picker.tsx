import { useState } from "react";
import { ErrorMessage, GitHubMark, Icon, Spinner } from "./ui";

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
}: {
  data?: RepositoryChoices;
  loading: boolean;
  refreshing: boolean;
  error: unknown;
  connectingId?: number;
  onConnect: (repository: RepositoryChoice) => void;
  onRefresh: () => void;
}) {
  const [search, setSearch] = useState("");
  const installed = !!data && ((data.installationCount ?? 0) > 0 || data.items.length > 0);
  const items =
    data?.items.filter((r) => r.name.toLowerCase().includes(search.trim().toLowerCase())) ?? [];

  if (loading) return <Spinner label="Finding your repositories…" />;
  if (!data)
    return (
      <div className="stack">
        <ErrorMessage error={error ?? Error("Your repositories could not load.")} />
        <div>
          <button className="btn" disabled={refreshing} onClick={onRefresh}>
            Try again
          </button>
        </div>
      </div>
    );
  if (!data.configured)
    return (
      <div className="stack">
        <p>This Traceyard server isn’t connected to a GitHub App yet.</p>
        <div>
          <a className="btn" href="/repository-setup">
            Setup instructions
          </a>
        </div>
      </div>
    );

  return (
    <div className="picker">
      <ErrorMessage error={error} />
      {data.items.length > 6 && (
        <label className="search">
          <Icon name="search" />
          <input
            type="search"
            aria-label="Find a repository"
            placeholder="Find a repository"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
      )}
      {items.length > 0 ? (
        <div className="list picker-list" role="group" aria-label="GitHub repositories">
          {items.map((r) => (
            <button
              key={r.id}
              className="row link"
              aria-label={"Connect " + r.name}
              aria-busy={connectingId === r.id}
              disabled={connectingId !== undefined}
              onClick={() => onConnect(r)}
            >
              <GitHubMark />
              <div className="row-main">
                <strong className="truncate">{r.name}</strong>
              </div>
              {connectingId === r.id ? (
                <span className="row-action">
                  <Icon name="spinner" /> Connecting…
                </span>
              ) : (
                <span className="row-action">Connect</span>
              )}
            </button>
          ))}
        </div>
      ) : (
        <div className="picker-empty">
          <strong>
            {data.items.length
              ? "No matching repositories"
              : installed
                ? "No repositories shared yet"
                : "Install the Traceyard GitHub App"}
          </strong>
          <p className="muted">
            {data.items.length
              ? "Try a different name."
              : installed
                ? "Choose which repositories Traceyard can access on GitHub, then refresh."
                : "Pick the repositories Traceyard can read. You can change this any time."}
          </p>
        </div>
      )}
      <div className="picker-actions">
        {!installed && data.installUrl && (
          <a className="btn primary" href={data.installUrl} target="_blank" rel="noreferrer">
            <GitHubMark /> Install on GitHub
          </a>
        )}
        {installed && data.manageUrl && (
          <a className="btn ghost" href={data.manageUrl} target="_blank" rel="noreferrer">
            Manage access
            <Icon name="external" />
          </a>
        )}
        <button
          className="btn ghost"
          disabled={refreshing || connectingId !== undefined}
          onClick={onRefresh}
        >
          <Icon name={refreshing ? "spinner" : "refresh"} />
          Refresh
        </button>
      </div>
    </div>
  );
}
