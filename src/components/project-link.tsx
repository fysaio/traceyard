import { useContext } from "react";
import { Link, type LinkProps } from "react-router-dom";
import { WorkspaceContext } from "../lib/workspace";
export function ProjectLink({ to, ...props }: LinkProps) {
  const workspace = useContext(WorkspaceContext);
  if (workspace?.projectId && typeof to === "string" && to.startsWith("/")) {
    const url = new URL(to, "https://traceyard.invalid");
    url.searchParams.set("project", workspace.projectId);
    to = url.pathname + url.search + url.hash;
  }
  return <Link {...props} to={to} />;
}
