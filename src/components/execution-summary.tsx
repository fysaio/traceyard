import type { Investigation } from "../../shared/contracts/investigations";

export function ExecutionSummary({
  execution,
}: {
  execution: NonNullable<Investigation["execution"]>;
}) {
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
            <code title={execution.commit ?? undefined}>
              {execution.commit?.slice(0, 12) ?? "Not confirmed"}
            </code>
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
      {!!execution.coverage?.omittedTests && (
        <p className="hint">
          {execution.coverage.omittedTests} related test file(s) were outside this execution’s
          coverage.
        </p>
      )}
    </section>
  );
}
