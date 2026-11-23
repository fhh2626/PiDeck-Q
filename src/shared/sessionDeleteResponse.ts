import type { SessionDeleteResult } from "./types/session";

/** Validate the HTTP deletion envelope without trusting a generic transport cast. */
export function parseSessionDeleteResponse(value: unknown): SessionDeleteResult {
  if (typeof value !== "object" || value === null || !("deleted" in value)) {
    throw new Error("Invalid session deletion response");
  }
  const deleted: unknown = value.deleted;
  if (typeof deleted === "boolean") return deleted;
  if (typeof deleted === "object" && deleted !== null && "status" in deleted
      && deleted.status === "trash-failed" && Object.keys(deleted).length === 1) {
    return { status: "trash-failed" };
  }
  throw new Error("Invalid session deletion response");
}
