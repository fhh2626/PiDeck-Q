import type { Project } from "../../../shared/types";

type ProjectListRequest = () => Promise<Project[]>;

let projectInventoryGeneration = 0;

/**
 * Invalidate project list responses that were started before an authoritative
 * project mutation or push event. The inventory has no backend revision field,
 * so renderer-side request generation is the compatibility guard.
 */
export function invalidateProjectInventoryRequests(): void {
  projectInventoryGeneration += 1;
}

/**
 * Load a project snapshot and return it only while it belongs to the newest
 * renderer request. A stale response is ignored instead of replacing newer
 * project paths or worktree records.
 */
export async function requestProjectInventory(
  list: ProjectListRequest,
): Promise<Project[] | undefined> {
  const request = ++projectInventoryGeneration;
  const projects = await list();
  return projectInventoryGeneration === request ? projects : undefined;
}
