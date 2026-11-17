import type { SourceFlow } from "../../shared/repository/source-flow";
import { Icon } from "./product-ui";

const contextLabels = {
  conditional: "Conditional path",
  error: "Error path",
  loop: "Loop",
  callback: "Callback",
};
export function SourceFlowTree({ flow, file }: { flow: SourceFlow; file: string }) {
  function branch(parent: string | null) {
    return (
      <ul className="flow-source-tree">
        {flow.steps
          .filter((step) => step.parentId === parent)
          .map((step) => {
            const children = flow.steps.some((child) => child.parentId === step.id);
            const label = (
              <>
                <span className="flow-source-call">
                  <Icon name="code" />
                  <strong>{step.name}</strong>
                </span>
                <span className="flow-source-meta">
                  <span>
                    {file}:{step.line}
                  </span>
                  {step.context && (
                    <span className="flow-source-tag">{contextLabels[step.context]}</span>
                  )}
                  <span>
                    {step.resolution === "local"
                      ? "Local function"
                      : step.resolution === "recursive"
                        ? "Recursive call"
                        : "Not resolved in this file"}
                  </span>
                </span>
              </>
            );
            return (
              <li key={step.id}>
                {children ? (
                  <details open>
                    <summary>{label}</summary>
                    {branch(step.id)}
                  </details>
                ) : (
                  <div className="flow-source-leaf">{label}</div>
                )}
              </li>
            );
          })}
      </ul>
    );
  }
  return (
    <>
      {branch(null)}
      {flow.truncated && (
        <p className="flow-note">
          This view is limited to 12 calls and three levels of local helpers. Some calls are not
          expanded.
        </p>
      )}
    </>
  );
}
