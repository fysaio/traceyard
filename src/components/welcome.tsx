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
        <nav className="welcome-nav" aria-label="Public navigation">
          <a href="#replay">How it works</a>
          <a href="#capabilities">Capabilities</a>
          <a className="btn ghost" href="https://github.com/fysaio/traceyard">
            <GitHubMark /> Source
          </a>
        </nav>
      </header>

      <main>
        <section className="welcome-hero" aria-labelledby="welcome-title">
          <div className="welcome-hero-copy">
            <p className="welcome-eyebrow">
              <span className="eyebrow-pulse" aria-hidden="true" /> Open-source test evidence for
              developers and agents
            </p>
            <h1 id="welcome-title">
              Don’t guess at the fix.
              <br />
              <em>Replay the failure.</em>
            </h1>
            <p className="welcome-lede">
              Traceyard runs the test that failed at the commit where it failed, then runs that same
              test against your repair. Every verdict keeps the evidence close.
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
                  <GitHubMark /> Continue with GitHub <Icon name="arrow-right" />
                </a>
              ) : (
                <p className="notice">
                  <Icon name="alert" />
                  <span>GitHub sign-in isn’t configured on this server.</span>
                </p>
              )}
              <a className="btn ghost lg" href="#replay">
                See the replay <Icon name="chevron-down" />
              </a>
            </div>
            <p className="welcome-microcopy">
              <span>MIT licensed</span>
              <span>Self-hostable</span>
              <span>No credit card</span>
            </p>
          </div>
          <div className="hero-signal" aria-label="Live Traceyard status">
            <div className="signal-orbit signal-orbit-one" aria-hidden="true" />
            <div className="signal-orbit signal-orbit-two" aria-hidden="true" />
            <div className="signal-core">
              <span className="signal-core-mark">T.</span>
              <span className="signal-core-label">evidence engine</span>
            </div>
            <div className="signal-card signal-card-top">
              <span className="signal-card-status">
                <span className="dot" /> capturing
              </span>
              <code>checkout.test.ts</code>
            </div>
            <div className="signal-card signal-card-bottom">
              <span className="signal-card-status pass">
                <span className="dot" /> verified
              </span>
              <code>same test · new commit</code>
            </div>
          </div>
        </section>

        <section className="replay-section" id="replay" aria-labelledby="replay-title">
          <div className="section-intro">
            <p className="eyebrow">A failure, without the fog</p>
            <h2 id="replay-title">From red build to retained proof.</h2>
            <p>Move through the replay. The interface changes because the evidence changes.</p>
          </div>
          <div className="replay-stage">
            <div className="replay-stage-head">
              <div>
                <span className="meta">
                  <Icon name="branch" /> fysaio/store · checkout
                </span>
                <strong>Retry submits the same order twice</strong>
              </div>
              <div className="segmented" role="group" aria-label="Failure replay state">
                <button type="button" aria-pressed={!fixed} onClick={() => setFixed(false)}>
                  Before
                </button>
                <button type="button" aria-pressed={fixed} onClick={() => setFixed(true)}>
                  After the fix
                </button>
              </div>
            </div>
            <div className="replay-grid" aria-live="polite" aria-atomic="true">
              <article className="replay-panel replay-failure">
                <div className="panel-chrome">
                  <span>
                    <span className="window-dot window-red" /> failure captured
                  </span>
                  <code>{fixed ? "5e15d4a" : "7cf9c40"}</code>
                </div>
                <div className="panel-copy">
                  <p className="panel-kicker">Original check</p>
                  <h3>{fixed ? "The failure is still visible." : "The failure has a shape."}</h3>
                  <p>
                    {fixed
                      ? "Traceyard keeps the original assertion beside the repair so the comparison stays honest."
                      : "A retry submitted the same order twice. The test caught the symptom, not the cause."}
                  </p>
                </div>
                <div className="terminal-lines" aria-label="Captured test output">
                  <div>
                    <span className="line-number">01</span>
                    <span>expect(order.submissions)</span>
                  </div>
                  <div>
                    <span className="line-number">02</span>
                    <span className={fixed ? "line-muted" : "line-fail"}>
                      {fixed ? "// original failure retained" : "received 2, expected 1"}
                    </span>
                  </div>
                  <div>
                    <span className="line-number">03</span>
                    <span>at checkout.test.ts:48</span>
                  </div>
                </div>
              </article>

              <div className="replay-bridge" aria-hidden="true">
                <span className="bridge-line" />
                <span className="bridge-arrow">
                  <Icon name="arrow-right" />
                </span>
                <span className="bridge-label">
                  same test
                  <br />
                  new commit
                </span>
              </div>

              <article className="replay-panel replay-proof">
                <div className="panel-chrome">
                  <span>
                    <span className={"window-dot " + (fixed ? "window-green" : "window-neutral")} />{" "}
                    verification
                  </span>
                  <span className={"panel-state " + (fixed ? "state-pass" : "state-waiting")}>
                    {fixed ? "fixed" : "waiting"}
                  </span>
                </div>
                <div className="panel-copy">
                  <p className="panel-kicker">Traceyard verdict</p>
                  <h3>{fixed ? "The repair holds." : "Ready to verify."}</h3>
                  <p>
                    {fixed
                      ? "The same test passes at the fix commit. The test file is unchanged."
                      : "Toggle after the fix to run the proof loop. No new test. No hand-waving."}
                  </p>
                </div>
                <div className="proof-steps">
                  <div className="proof-step">
                    <span className="proof-icon">
                      <Icon name="check" />
                    </span>
                    <span>Read source</span>
                    <code>204 files</code>
                  </div>
                  <div className="proof-step">
                    <span className="proof-icon">
                      <Icon name="check" />
                    </span>
                    <span>Reproduce</span>
                    <code>{fixed ? "1 passed" : "1 failed"}</code>
                  </div>
                  <div className="proof-step">
                    <span
                      className={"proof-icon " + (fixed ? "proof-icon-pass" : "proof-icon-neutral")}
                    >
                      <Icon name={fixed ? "passed" : "circle"} />
                    </span>
                    <span>Verify repair</span>
                    <code>{fixed ? "evidence kept" : "next step"}</code>
                  </div>
                </div>
              </article>
            </div>
            <div className="replay-foot">
              <span>
                <Icon name="repository" /> Source-linked evidence
              </span>
              <span>
                <Icon name="agent" /> Works with your coding agent
              </span>
              <span>
                <Icon name="check" /> One focused verdict
              </span>
            </div>
          </div>
        </section>

        <section
          className="capabilities-section"
          id="capabilities"
          aria-labelledby="capabilities-title"
        >
          <div className="section-intro section-intro-wide">
            <p className="eyebrow">The control room</p>
            <h2 id="capabilities-title">Everything important stays in frame.</h2>
            <p>Traceyard turns a noisy failure into a small, legible sequence of decisions.</p>
          </div>
          <div className="capability-grid">
            <article className="capability-card capability-card-large">
              <div className="capability-card-top">
                <span className="card-index">01</span>
                <Icon name="repository" />
              </div>
              <h3>Repository context</h3>
              <p>
                Start from the repository and commit that actually produced the failure. Not a
                guessed branch. Not a detached log.
              </p>
              <div className="mini-repo-card">
                <span className="mini-avatar">S</span>
                <span>
                  <strong>fys aio / store</strong>
                  <small>main · 7cf9c40</small>
                </span>
                <span className="mini-live">
                  <span className="dot" /> connected
                </span>
              </div>
            </article>
            <article className="capability-card capability-card-dark">
              <div className="capability-card-top">
                <span className="card-index">02</span>
                <Icon name="bug" />
              </div>
              <h3>Evidence, not a wall of logs</h3>
              <p>
                Human-readable findings first. Technical output stays available when you need to go
                deeper.
              </p>
              <div className="evidence-bars" aria-hidden="true">
                <span />
                <span />
                <span />
                <span />
                <span />
                <span />
              </div>
              <span className="card-caption">retained structured evidence</span>
            </article>
            <article className="capability-card capability-card-agent">
              <div className="capability-card-top">
                <span className="card-index">03</span>
                <Icon name="agent" />
              </div>
              <h3>Ready for your agent</h3>
              <p>
                Connect ChatGPT, Antigravity, or another MCP client with access scoped to the
                repository you choose.
              </p>
              <div className="agent-line">
                <span className="agent-avatar">C</span>
                <span>ChatGPT</span>
                <span className="agent-connection">
                  <span className="dot" /> scoped
                </span>
              </div>
              <div className="agent-line">
                <span className="agent-avatar agent-avatar-muted">A</span>
                <span>Antigravity</span>
                <span className="agent-connection agent-pending">connect</span>
              </div>
            </article>
          </div>
        </section>

        <section className="welcome-close" aria-labelledby="close-title">
          <p className="eyebrow">Make the next failure useful</p>
          <h2 id="close-title">
            Find what broke.
            <br />
            <em>Prove it’s fixed.</em>
          </h2>
          <p>
            Open-source, self-hostable, and built for the moment between “it failed” and “ship it.”
          </p>
          {session.githubSignInAvailable && (
            <a className="btn primary lg" href="/api/auth/github/start">
              <GitHubMark /> Continue with GitHub <Icon name="arrow-right" />
            </a>
          )}
        </section>
      </main>

      <footer className="welcome-foot muted">
        <span>Traceyard.</span>
        <span>MIT licensed · Self-hostable · Built for evidence</span>
      </footer>
    </div>
  );
}
