import { Link } from "react-router-dom";

import { EmptyState } from "../components/empty-state";
import { PageHeader } from "../components/page-header";
import { Icon } from "../components/ui/icon";

export function NotFoundPage() {
  return (
    <>
      <PageHeader
        eyebrow="404"
        title="Page not found"
        description="This route does not exist in the Traceyard console."
      />
      <EmptyState
        icon={<Icon name="compass" />}
        title="Nothing at this address"
        description="The console exposes Overview, Executions, Workflows, Analytics and Settings. Execution detail pages require a run ID created by this session."
        action={
          <Link
            to="/"
            className="inline-flex h-8 items-center rounded-md bg-ink px-3 text-xs font-medium text-canvas no-underline hover:opacity-80"
          >
            Return to overview
          </Link>
        }
      />
    </>
  );
}
