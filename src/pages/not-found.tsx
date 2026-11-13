import { Compass } from "lucide-react";
import { Link } from "react-router-dom";

import { EmptyState } from "../components/empty-state";
import { PageHeader } from "../components/page-header";
import { Button } from "../components/ui/button";

export function NotFoundPage() {
  return (
    <>
      <PageHeader
        eyebrow="404"
        title="Page not found"
        description="This route does not exist in the Traceyard console."
      />
      <EmptyState
        icon={<Compass className="size-4" />}
        title="Nothing at this address"
        description="The console exposes Overview, Executions, Workflows, Analytics and Settings. Execution detail pages require a run ID created by this session."
        action={
          <Button variant="primary" size="sm">
            <Link to="/">Return to overview</Link>
          </Button>
        }
      />
    </>
  );
}
