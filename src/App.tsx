import { Route, Routes } from "react-router-dom";

import { AppShell } from "./components/app-shell";
import { AnalyticsPage } from "./pages/analytics";
import { ExecutionDetailPage } from "./pages/execution-detail";
import { ExecutionsPage } from "./pages/executions";
import { NotFoundPage } from "./pages/not-found";
import { OverviewPage } from "./pages/overview";
import { SettingsPage } from "./pages/settings";
import { WorkflowsPage } from "./pages/workflows";

export function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<OverviewPage />} />
        <Route path="executions" element={<ExecutionsPage />} />
        <Route path="executions/:runId" element={<ExecutionDetailPage />} />
        <Route path="workflows" element={<WorkflowsPage />} />
        <Route path="analytics" element={<AnalyticsPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
