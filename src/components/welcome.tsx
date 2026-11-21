import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { AuthSession } from "../lib/api";
import { GitHubMark, Icon } from "./ui";

const timelineStages = [
  {
    number: "01",
    label: "Failing commit",
    title: "The check has a shape.",
    description:
      "TraceYard starts with the repository, branch, workflow, and exact commit that produced the failure.",
    commit: "7cf9c40",
    meta: "checkout.test.ts · 48",
    status: "failed",
    statusLabel: "failure captured",
    detail: "received 2, expected 1",
  },
  {
    number: "02",
    label: "Reproduction",
    title: "Run the same test again.",
    description:
      "The original assertion stays in view while TraceYard reproduces the behavior in its real context.",
    commit: "7cf9c40",
    meta: "same test · same commit",
    status: "running",
    statusLabel: "reproducing",
    detail: "1 test · 3 artifacts retained",
  },
  {
    number: "03",
    label: "Verified fix",
    title: "The repair holds.",
    description:
      "The unchanged test passes at the repair commit, with the comparison and evidence kept together.",
    commit: "5e15d4a",
    meta: "checkout.test.ts · verified",
    status: "verified",
    statusLabel: "verification complete",
    detail: "1 passed · evidence kept",
  },
] as const;

export function Welcome({ session }: { session: AuthSession }) {
  const [params] = useSearchParams();
  const signIn = params.get("signIn");
  const [stage, setStage] = useState(0);
  const active = timelineStages[stage] ?? timelineStages[0];

  return (
    <div className="welcome editorial-welcome">
      <header className="welcome-header editorial-header">
        <a href="/" className="brand" aria-label="Traceyard home">
          Traceyard<span>.</span>
        </a>
        <nav className="welcome-nav" aria-label="Public navigation">
          <a href="#timeline">The trace</a>
          <a href="#workflow">Workflow</a>
          <a className="btn ghost" href="https://github.com/fysaio/traceyard">
            <GitHubMark /> Source
          </a>
        </nav>
      </header>

      <main>
        <section className="editorial-hero" aria-labelledby="welcome-title">
          <div className="editorial-hero-meta">
            <span>Traceyard / 01</span>
            <span>Open-source test evidence</span>
          </div>
          <div className="editorial-hero-grid">
            <div className="editorial-hero-copy">
              <p className="editorial-kicker">For developers and coding agents</p>
              <h1 id="welcome-title">
                See the failure
                <br />
                <em>where it began.</em>
              </h1>
              <p className="welcome-lede">
                TraceYard connects the failing commit, the reproduction, and the verified repair so
                a fix can be trusted—not guessed at.
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
                    <GitHubMark /> Start with GitHub <Icon name="arrow-right" />
                  </a>
                ) : (
                  <p className="notice">
                    <Icon name="alert" />
                    <span>GitHub sign-in isn’t configured on this server.</span>
                  </p>
                )}
                <a className="btn ghost lg" href="#timeline">
                  Read the trace <Icon name="chevron-down" />
                </a>
              </div>
              <p className="welcome-microcopy">
                <span>MIT licensed</span>
                <span>Self-hostable</span>
                <span>Evidence stays attached</span>
              </p>
            </div>

            <div className="editorial-hero-index" aria-hidden="true">
              <span>01</span>
              <span>02</span>
              <span>03</span>
            </div>
          </div>
        </section>

        <section className="timeline-section" id="timeline" aria-labelledby="timeline-title">
          <div className="editorial-section-head">
            <div>
              <p className="editorial-kicker">A trace in three movements</p>
              <h2 id="timeline-title">From signal to certainty.</h2>
            </div>
            <p>
              Select a stage. The product view changes because the evidence changes—nothing is
              decorative, and nothing is hidden behind a demo animation.
            </p>
          </div>

          <div className="timeline-nav" role="tablist" aria-label="Trace stages">
            {timelineStages.map((item, index) => (
              <button
                key={item.number}
                type="button"
                role="tab"
                aria-selected={stage === index}
                className={stage === index ? "timeline-tab is-active" : "timeline-tab"}
                onClick={() => setStage(index)}
              >
                <span>{item.number}</span>
                <strong>{item.label}</strong>
              </button>
            ))}
          </div>

          <div className="timeline-rule" aria-hidden="true">
            <span className="timeline-rule-progress" style={{ width: `${stage * 50 + 25}%` }} />
          </div>

          <article className={`trace-panel trace-panel-${active.status}`} aria-live="polite">
            <div className="trace-panel-topline">
              <span>fysaio / store · checkout</span>
              <span className={`trace-status trace-status-${active.status}`}>
                <span className="trace-status-dot" /> {active.statusLabel}
              </span>
            </div>
            <div className="trace-panel-body">
              <div className="trace-panel-copy">
                <p className="trace-overline">
                  {active.number} / {active.label}
                </p>
                <h3>{active.title}</h3>
                <p>{active.description}</p>
                <div className="trace-commit-row">
                  <code>{active.commit}</code>
                  <span>{active.meta}</span>
                </div>
              </div>
              <div className="trace-evidence" aria-label="Trace evidence">
                <div className="trace-evidence-head">
                  <span>captured output</span>
                  <Icon name="check" />
                </div>
                <div className="trace-output">
                  <span className="trace-line-number">01</span>
                  <code>expect(order.submissions)</code>
                  <span className="trace-line-number">02</span>
                  <code className={`trace-output-${active.status}`}>{active.detail}</code>
                  <span className="trace-line-number">03</span>
                  <code>at checkout.test.ts:48</code>
                </div>
                <div className="trace-evidence-foot">
                  <span>repository context</span>
                  <span>evidence retained</span>
                </div>
              </div>
            </div>
          </article>
        </section>

        <section className="workflow-section" id="workflow" aria-labelledby="workflow-title">
          <div className="workflow-intro">
            <p className="editorial-kicker">The working model</p>
            <h2 id="workflow-title">A smaller story for a noisy failure.</h2>
            <p>
              TraceYard puts the human-readable finding first, then keeps the exact commit, command,
              and output close enough to inspect.
            </p>
          </div>
          <div className="workflow-chapters">
            <article>
              <span>01</span>
              <h3>Context</h3>
              <p>Start from the repository and commit that actually produced the signal.</p>
            </article>
            <article>
              <span>02</span>
              <h3>Reproduce</h3>
              <p>Run the same test in the same context before changing the story.</p>
            </article>
            <article>
              <span>03</span>
              <h3>Verify</h3>
              <p>Compare the repair with the original evidence and keep the proof attached.</p>
            </article>
          </div>
        </section>

        <section className="surface-section" aria-labelledby="surface-title">
          <div className="surface-copy">
            <p className="editorial-kicker">One product, different surfaces</p>
            <h2 id="surface-title">Use the browser. Bring your agent.</h2>
            <p>
              TraceYard keeps repository scope, permissions, execution state, and evidence legible
              whether you start in the workspace or through MCP.
            </p>
          </div>
          <div className="surface-card">
            <div className="surface-card-head">
              <span>shared context</span>
              <span className="trace-status trace-status-verified">
                <span className="trace-status-dot" /> scoped
              </span>
            </div>
            <div className="surface-row">
              <span>Browser workspace</span>
              <code>investigate</code>
            </div>
            <div className="surface-row">
              <span>MCP / coding agent</span>
              <code>evidence.read</code>
            </div>
            <div className="surface-row">
              <span>Repository</span>
              <code>fysaio/store</code>
            </div>
          </div>
        </section>

        <section className="editorial-close" aria-labelledby="close-title">
          <p className="editorial-kicker">Make the next failure useful</p>
          <h2 id="close-title">
            Know what broke.
            <br />
            <em>Know why it’s fixed.</em>
          </h2>
          <p>
            Open-source, self-hostable, and built for the moment between “it failed” and “ship it.”
          </p>
          {session.githubSignInAvailable && (
            <a className="btn primary lg" href="/api/auth/github/start">
              <GitHubMark /> Start with GitHub <Icon name="arrow-right" />
            </a>
          )}
        </section>
      </main>

      <footer className="welcome-foot editorial-foot muted">
        <span>Traceyard.</span>
        <span>MIT licensed · Self-hostable · Built for evidence</span>
      </footer>
    </div>
  );
}
