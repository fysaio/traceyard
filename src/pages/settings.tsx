import { useState } from "react";
import { NavLink, Navigate, useParams } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type AuthSession } from "../lib/api";
import { readPreference, savePreference } from "../lib/workspace";
import { ErrorMessage, Icon, PageHeader, formatTime, type IconName } from "../components/ui";

const SESSION_PREVIEW = 5;

const SECTIONS = [
  ["account", "Account"],
  ["appearance", "Appearance"],
] as const;

export function SettingsPage({ session }: { session: AuthSession }) {
  const { section } = useParams();
  if (!SECTIONS.some(([id]) => id === section)) return <Navigate to="/settings/account" replace />;
  return (
    <div className="page">
      <PageHeader title="Settings" />
      <nav className="tabs" aria-label="Settings">
        {SECTIONS.map(([id, label]) => (
          <NavLink
            key={id}
            to={"/settings/" + id}
            className={({ isActive }) => (isActive ? "active" : undefined)}
          >
            {label}
          </NavLink>
        ))}
      </nav>
      {section === "account" ? <Account session={session} /> : <Appearance />}
    </div>
  );
}

function Account({ session }: { session: AuthSession }) {
  const cache = useQueryClient(),
    user = session.user!;
  const [expanded, setExpanded] = useState(false);
  const revoke = useMutation({
    mutationFn: api.revokeSession,
    onSuccess: () => cache.invalidateQueries({ queryKey: ["auth"] }),
  });
  const revokeOthers = useMutation({
    mutationFn: (ids: string[]) => Promise.all(ids.map((id) => api.revokeSession(id))),
    onSettled: () => cache.invalidateQueries({ queryKey: ["auth"] }),
  });
  const sessions = [...session.sessions].sort(
    (a, b) => Number(b.current) - Number(a.current) || b.lastSeenAt.localeCompare(a.lastSeenAt),
  );
  const others = sessions.filter((s) => !s.current);
  const visible = expanded ? sessions : sessions.slice(0, SESSION_PREVIEW);
  const hidden = sessions.length - visible.length;
  const busy = revoke.isPending || revokeOthers.isPending;
  return (
    <div className="stack-lg">
      <section className="card identity">
        {user.avatarUrl ? (
          <img src={user.avatarUrl} alt="" width={48} height={48} />
        ) : (
          <span className="identity-fallback">
            <Icon name="user" size={20} />
          </span>
        )}
        <div>
          <h2>{user.name || user.login}</h2>
          <p className="muted">Signed in with GitHub as @{user.login}</p>
        </div>
      </section>
      <section className="stack">
        <div className="section-head">
          <h2 className="section-title">Sessions</h2>
          {others.length > 1 ? (
            <button
              className="btn ghost"
              disabled={busy}
              onClick={() => revokeOthers.mutate(others.map((s) => s.id))}
            >
              {revokeOthers.isPending ? "Signing out…" : "Sign out other browsers"}
            </button>
          ) : null}
        </div>
        <div className="list">
          {visible.map((s) => (
            <div className="row" key={s.id}>
              <div className="row-main">
                <strong>{s.current ? "This browser" : "Another browser"}</strong>
                <span className="muted">Last active {formatTime(s.lastSeenAt)}</span>
              </div>
              {s.current ? (
                <span className="muted">Current</span>
              ) : (
                <button className="btn" disabled={busy} onClick={() => revoke.mutate(s.id)}>
                  Sign out
                </button>
              )}
            </div>
          ))}
          {hidden > 0 ? (
            <button className="row row-more" onClick={() => setExpanded(true)}>
              Show {hidden} more
            </button>
          ) : null}
        </div>
        <ErrorMessage error={revoke.error ?? revokeOthers.error} />
      </section>
    </div>
  );
}

const THEMES: [value: string, label: string, icon: IconName][] = [
  ["system", "System", "system"],
  ["light", "Light", "light"],
  ["dark", "Dark", "dark"],
];

function Appearance() {
  const [theme, setTheme] = useState(() => readPreference("theme", "system"));
  const choose = (value: string) => {
    savePreference("theme", value);
    setTheme(value);
    document.documentElement.dataset.theme =
      value === "system"
        ? matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light"
        : value;
  };
  return (
    <section className="stack">
      <h2 className="section-title">Theme</h2>
      <div className="theme-options" role="radiogroup" aria-label="Theme">
        {THEMES.map(([value, label, icon]) => (
          <button
            key={value}
            role="radio"
            aria-checked={theme === value}
            className="theme-option"
            onClick={() => choose(value)}
          >
            <span className={"theme-preview " + value} aria-hidden="true">
              <span />
              <span />
            </span>
            <span className="theme-label">
              <Icon name={icon} />
              {label}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
