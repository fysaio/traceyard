import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { AuthSession } from "../lib/api";
import { GitHubMark, Icon } from "./ui";

export function Welcome({ session }: { session: AuthSession }) {
  const [params] = useSearchParams();
  const signIn = params.get("signIn");
  const [fixed, setFixed] = useState(false);

  return (
    <div className="welcome">
      <header className="welcome-header">
        <a href="/" className="brand" aria-label="Traceyard home">
          Traceyard<span>.</span>
        </a>
        <a className="btn ghost" href="https://github.com/fysaio/traceyard">
          <GitHubMark /> Source
        </a>
      </header>
      <main className="welcome-main">
        <div className="welcome-copy">
          <h1>
            Find what broke.
            <br />
            Prove it’s fixed.
          </h1>
          <p className="welcome-lede">
            Traceyard runs the test that failed, at the commit where it failed, then runs it again
            against your fix. You, or your coding agent, get a verdict backed by evidence.
          </p>
          {(signIn === "retry" || signIn === "cancelled") && (
            <p className="notice" role="alert">
              <Icon name="alert" />
              <span>
                {signIn === "cancelled"
                  ? "Sign-in was cancelled. Continue with GitHub when you’re ready."
                  : "That sign-in link expired. Continue with GitHub to try again."}
              </span>
            </p>
          )}
          <div className="welcome-actions">
            {session.githubSignInAvailable ? (
              <a className="btn primary lg" href="/api/auth/github/start">
                <GitHubMark /> Continue with GitHub
              </a>
            ) : (
              <p className="notice">
                <Icon name="alert" />
                <span>GitHub sign-in isn’t configured on this server.</span>
              </p>
            )}
          </div>
          <p className="muted">Free and open source. Works in the browser or over MCP.</p>
        </div>

        <section className="welcome-demo card" aria-labelledby="example-title">
          <div className="demo-head">
            <span className="meta">
              <Icon name="branch" />
              store / checkout
            </span>
            <span className="muted">Example</span>
          </div>
          <h2 id="example-title">Why does checkout fail on retry?</h2>
          <div className="segmented" role="group" aria-label="Example result">
            <button type="button" aria-pressed={!fixed} onClick={() => setFixed(false)}>
              Before
            </button>
            <button type="button" aria-pressed={fixed} onClick={() => setFixed(true)}>
              After the fix
            </button>
          </div>
          <div className="demo-result" aria-live="polite" aria-atomic="true" key={String(fixed)}>
            <div className="demo-line">
              <code>checkout.test.ts</code>
              <span className={"badge " + (fixed ? "pass" : "fail")}>
                <span className="dot" />
                {fixed ? "1 passed" : "1 failed"}
              </span>
            </div>
            <p>
              {fixed
                ? "The same test passes at the fix commit. The test file is unchanged."
                : "A retry submitted the same order twice."}
            </p>
            <div className="demo-verdict">
              <span className="field-label">Verdict</span>
              <strong>{fixed ? "Fixed" : "Reproduced"}</strong>
            </div>
          </div>
        </section>
      </main>
      <footer className="welcome-foot muted">MIT licensed · Self-hostable</footer>
    </div>
  );
}
