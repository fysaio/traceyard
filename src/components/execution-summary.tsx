import type { Investigation } from "../../shared/contracts/investigations";
import { flakinessOutcome } from "../../shared/contracts/investigation-execution";

export function ExecutionSummary({
  execution,
}: {
  execution: NonNullable<Investigation["execution"]>;
}) {
  if (execution.flakeRuns) {
    const outcome = flakinessOutcome(execution.flakeRuns);
    return (
      <section className="execution-summary" aria-label="Flakiness results">
        <h3>{outcome.label}</h3>
        <p>{outcome.summary}</p>
        {[execution.flakeRuns.slice(0, 3), execution.flakeRuns.slice(3)].map((runs, index) => (
          <section key={index} className="section">
            <h4>
              {index === 0 ? "Failing commit" : "Candidate commit"} <code>{runs[0]?.commit}</code>
            </h4>
            {runs.map((run) => (
              <details className="disclosure" key={run.attempt}>
                <summary>
                  Attempt {run.attempt} ·{" "}
                  {run.status === "SUCCEEDED"
                    ? "Passed"
                    : run.status === "FAILED"
                      ? "Failed"
                      : "Blocked"}{" "}
                  · {(run.durationMs / 1000).toFixed(1)}s
                </summary>
                <pre className="code">{run.message}</pre>
              </details>
            ))}
          </section>
        ))}
      </section>
    );
  }
  return (
    <section className="execution-summary" aria-label="Test execution result">
      <div className="test-counts">
        <span>
          <strong>{execution.counts.passed}</strong> passed
        </span>
        <span className={execution.counts.failed ? "has-failures" : ""}>
          <strong>{execution.counts.failed}</strong> failed
        </span>
        <span>
          <strong>{execution.counts.skipped}</strong> skipped
        </span>
      </div>
      <dl className="result-facts">
        <div>
          <dt>Test</dt>
          <dd>
            <code>{execution.command.testPath ?? "Selected checks"}</code>
          </dd>
        </div>
        <div>
          <dt>Executed revision</dt>
          <dd>
            <code title={execution.commit ?? undefined}>{execution.commit ?? "Not confirmed"}</code>
          </dd>
        </div>
        <div>
          <dt>Duration</dt>
          <dd>{(execution.durationMs / 1000).toFixed(2)}s</dd>
        </div>
        <div>
          <dt>Exit code</dt>
          <dd>{execution.exitCode ?? "Not reported"}</dd>
        </div>
      </dl>
      {execution.failures.map((failure, index) => (
        <article className="test-failure" key={index}>
          <h3>{failure.name}</h3>
          <p className="hint">{failure.file}</p>
          <pre className="code">{failure.message}</pre>
        </article>
      ))}
      {execution.output && (
        <details className="disclosure">
          <summary>Retained test output</summary>
          <pre className="code">{execution.output}</pre>
        </details>
      )}
      {!!execution.coverage?.omittedTests && (
        <p className="hint">
          {execution.coverage.omittedTests} related test file(s) were outside this execution’s
          coverage.
        </p>
      )}
    </section>
  );
}
