import { createContext, useContext } from "react";
import type { AuthSession, ProjectSummary } from "./api";
export interface WorkspaceState {
  session: AuthSession;
  projects: ProjectSummary[];
  projectId: string;
  selectProject: (id: string) => void;
  openConnect: () => void;
}
export const WorkspaceContext = createContext<WorkspaceState | null>(null);
export function useWorkspace() {
  const value = useContext(WorkspaceContext);
  if (!value) throw Error("Workspace context is unavailable.");
  return value;
}
export function readPreference(key: string, fallback = "") {
  try {
    return localStorage.getItem("traceyard:" + key) ?? fallback;
  } catch {
    return fallback;
  }
}
export function savePreference(key: string, value: string) {
  try {
    localStorage.setItem("traceyard:" + key, value);
  } catch {
    /* Preferences never block navigation. */
  }
}
