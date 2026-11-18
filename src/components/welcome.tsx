import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { AuthSession } from "../lib/api";
import { Icon } from "./product-ui";

export function Welcome({ session }: { session: AuthSession }) {
  const [params] = useSearchParams();
  const signIn = params.get("signIn");
  const [showRepair, setShowRepair] = useState(false);

  return (
    <div className="welcome">
      <header className="welcome-header">
        <a href="/" className="brand" aria-label="Traceyard home">
          Traceyard<span>.</span>
        </a>
        <a className="welcome-source" href="https://github.com/fysaio/traceyard">
          <i className="fa-brands fa-github" aria-hidden="true" /> View source
        </a>
      </header>
      <main className="welcome-main">
        <div className="welcome-copy">
          <h1>
            Find what broke.
            <br />
            Prove it’s fixed.
          </h1>
          <p>
            Run the test that matters. Traceyard saves what happened and checks your fix against the
            same failure.
          </p>
          {(signIn === "retry" || signIn === "cancelled") && (
            <p className="welcome-notice" role="alert">
              {signIn === "cancelled"
                ? "Sign-in was cancelled. Continue with GitHub when you’re ready."
                : "That sign-in link expired or could not be verified. Continue with GitHub to try again."}
            </p>
          )}
          <div className="welcome-actions">
            {session.githubSignInAvailable ? (
              <a className="btn primary" href="/api/auth/github/start">
                <i className="fa-brands fa-github" aria-hidden="true" /> Continue with GitHub
              </a>
            ) : (
              <p className="welcome-notice">GitHub sign-in is unavailable right now.</p>
            )}
            <a className="welcome-example-link" href="#investigation-example">
              See an example <Icon name="arrow-down" />
            </a>
          </div>
          <p className="welcome-note">Use it in your browser or with your coding agent.</p>
        </div>
        <section
          className="welcome-visual"
          aria-labelledby="example-title"
          id="investigation-example"
        >
          <div className="welcome-example">
            <div className="welcome-example-top">
              <span>
                <Icon name="code-branch" /> store / checkout
              </span>
              <span>Example investigation</span>
            </div>
            <h2 id="example-title">Why does checkout fail on retry?</h2>
            <div className="welcome-example-controls" role="group" aria-label="Example result">
              <button type="button" aria-pressed={!showRepair} onClick={() => setShowRepair(false)}>
                Original failure
              </button>
              <button type="button" aria-pressed={showRepair} onClick={() => setShowRepair(true)}>
                After the fix
              </button>
            </div>
            <div className="welcome-example-result" aria-live="polite" aria-atomic="true">
              <p className={showRepair ? "example-passed" : "example-failed"}>
                <Icon name={showRepair ? "circle-check" : "circle-xmark"} />
                {showRepair ? "1 passed" : "1 failed"}
              </p>
              <code>checkout.test.ts</code>
              <p>
                {showRepair
                  ? "The same test now passes. The test itself was unchanged."
                  : "A retry submitted the same order twice."}
              </p>
            </div>
          </div>
        </section>
      </main>
      <footer className="welcome-foot">Open source. Self-hostable.</footer>
    </div>
  );
}
