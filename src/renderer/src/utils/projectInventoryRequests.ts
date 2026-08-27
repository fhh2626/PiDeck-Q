import type { Project } from "../../../shared/types";

type ProjectListRequest = () => Promise<Project[]>;

let projectInventoryInvalidationEpoch = 0;
let projectInventoryRequestSequence = 0;
let latestAppliedProjectInventorySequence = 0;

/**
 * Invalidate project list responses that started before an authoritative
 * project mutation or push event. The inventory has no backend revision field,
 * so this epoch is the compatibility guard for mutation boundaries.
 */
export function invalidateProjectInventoryRequests(): void {
  projectInventoryInvalidationEpoch += 1;
}

/**
 * Load a project snapshot without making a merely newer in-flight request
 * invalidate an older request that may still be the only successful result.
 * Only a successful response advances the applied sequence.
 */
export async function requestProjectInventory(
  list: ProjectListRequest,
): Promise<Project[] | undefined> {
  const epoch = projectInventoryInvalidationEpoch;
  const requestSequence = ++projectInventoryRequestSequence;
  const projects = await list();
  if (epoch !== projectInventoryInvalidationEpoch) return undefined;
  if (requestSequence < latestAppliedProjectInventorySequence) return undefined;
  latestAppliedProjectInventorySequence = requestSequence;
  return projects;
}
