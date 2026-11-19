import type { Investigation } from "../../shared/contracts/investigations";
import { flakinessOutcome } from "../../shared/contracts/investigation-execution";
import { Badge, Icon } from "./ui";

const runLabel = (status: string) =>
  status === "SUCCEEDED" ? "Passed" : status === "FAILED" ? "Failed" : "Blocked";
const runTone = (status: string) =>
  status === "SUCCEEDED" ? "pass" : status === "FAILED" ? "fail" : "warn";

export function ExecutionSummary({
  execution,
}: {
  execution: NonNullable<Investigation["execution"]>;
}) {
  if (execution.flakeRuns) {
    const outcome = flakinessOutcome(execution.flakeRuns);
    return (
      <section className="stack" aria-label="Flakiness results">
        <div>
          <h3>{outcome.label}</h3>
          <p className="muted">{outcome.summary}</p>
        </div>
        {[execution.flakeRuns.slice(0, 3), execution.flakeRuns.slice(3)].map((runs, index) => (
          <div key={index} className="stack-sm">
            <p className="field-label">
              {index === 0 ? "Failing commit" : "Candidate commit"}{" "}
              <code>{runs[0]?.commit.slice(0, 12)}</code>
            </p>
            <div className="list">
              {runs.map((run) => (
                <details className="row-details" key={run.attempt}>
                  <summary className="row">
                    <Icon name="chevron-right" />
                    <div className="row-main">
                      <strong>Attempt {run.attempt}</strong>
                      <span className="muted">{(run.durationMs / 1000).toFixed(1)}s</span>
                    </div>
                    <Badge tone={runTone(run.status)}>{runLabel(run.status)}</Badge>
                  </summary>
                  <pre className="code flush">{run.message}</pre>
                </details>
              ))}
            </div>
          </div>
        ))}
      </section>
    );
  }
  const { counts } = execution;
  return (
    <section className="stack" aria-label="Test execution result">
      <div className="counts">
        <span className={counts.passed ? "count pass" : "count"}>
          <strong>{counts.passed}</strong> passed
        </span>
        <span className={counts.failed ? "count fail" : "count"}>
          <strong>{counts.failed}</strong> failed
        </span>
        <span className="count">
          <strong>{counts.skipped}</strong> skipped
        </span>
      </div>
      <dl className="facts">
        <div className="wide">
          <dt>Test</dt>
          <dd>
            <code>
              {execution.command.testPath ?? "Selected checks"}
              {execution.command.testCase && "::" + execution.command.testCase}
            </code>
          </dd>
        </div>
        <div>
          <dt>Commit</dt>
          <dd>
            <code title={execution.commit ?? undefined}>
              {execution.commit ? execution.commit.slice(0, 7) : "Not confirmed"}
            </code>
          </dd>
        </div>
        <div>
          <dt>Duration</dt>
          <dd>{(execution.durationMs / 1000).toFixed(1)}s</dd>
        </div>
        <div>
          <dt>Exit code</dt>
          <dd>{execution.exitCode ?? "Not reported"}</dd>
        </div>
      </dl>
      {execution.failures.map((failure, index) => (
        <article className="failure" key={index}>
          <div className="failure-head">
            <Icon name="failed" />
            <strong>{failure.name}</strong>
          </div>
          {failure.file !== execution.command.testPath && (
            <p className="muted mono">{failure.file}</p>
          )}
          <pre className="code">{failure.message}</pre>
        </article>
      ))}
      {execution.output && (
        <details className="disclosure">
          <summary>
            <Icon name="chevron-right" />
            Test output
          </summary>
          <pre className="code">{execution.output}</pre>
        </details>
      )}
      {!!execution.coverage?.omittedTests && (
        <p className="muted">
          {execution.coverage.omittedTests} related test{" "}
          {execution.coverage.omittedTests === 1 ? "file was" : "files were"} not part of this run.
        </p>
      )}
    </section>
  );
}
