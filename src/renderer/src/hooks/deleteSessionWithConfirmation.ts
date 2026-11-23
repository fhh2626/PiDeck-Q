import type { SessionDeleteOptions, SessionDeleteResult } from "../../../shared/types";
import type { ConfirmDialogConfig } from "../utils/confirmationQueue";
import { t } from "../i18n";

export type SessionDeleteOutcome = "deleted" | "cancelled" | "failed";
type DeleteRecord = (id: string, options?: SessionDeleteOptions) => Promise<SessionDeleteResult>;
interface DeleteSessionInput {
  sessionId: string;
  sessionTitle?: string;
  deleteRecord: DeleteRecord;
  showConfirm: (confirm: ConfirmDialogConfig) => void;
  clearConfirm: () => void;
  onSuccess: () => void | Promise<void>;
  onError: (error: unknown) => void;
}

// This is an in-flight command cache, not UI state. Completed operations are removed,
// and distinct API owners cannot accidentally share a deletion or its authorization.
const pending = new WeakMap<DeleteRecord, Map<string, Promise<SessionDeleteOutcome>>>();

/** Wait for the complete confirmation lifecycle; only explicit consent authorizes a retry. */
export function deleteSessionWithConfirmation(input: DeleteSessionInput): Promise<SessionDeleteOutcome> {
  let operations = pending.get(input.deleteRecord);
  if (!operations) {
    operations = new Map();
    pending.set(input.deleteRecord, operations);
  }
  const existing = operations.get(input.sessionId);
  if (existing) return existing;
  const task = performDelete(input);
  operations.set(input.sessionId, task);
  const release = () => operations.delete(input.sessionId);
  void task.then(release, release);
  return task;
}

async function performDelete(input: DeleteSessionInput): Promise<SessionDeleteOutcome> {
  try {
    let result = await input.deleteRecord(input.sessionId);
    if (typeof result !== "boolean" && result.status === "trash-failed") {
      const accepted = await new Promise<boolean>((resolve) => {
        let settled = false;
        const finish = (confirmed: boolean) => {
          if (settled) return;
          settled = true;
          resolve(confirmed);
        };
        input.showConfirm({
          title: t("app.sessionTrashFailedTitle"),
          message: t("app.sessionTrashFailedBody", { name: input.sessionTitle || input.sessionId }),
          danger: true,
          confirmLabel: t("app.sessionPermanentDelete"),
          onConfirm: () => { input.clearConfirm(); finish(true); },
          onCancel: () => finish(false),
        });
      });
      if (!accepted) return "cancelled";
      result = await input.deleteRecord(input.sessionId, { permanent: true });
    }
    if (typeof result !== "boolean") throw new Error(t("app.sessionPermanentDeleteFailed"));
    // The deletion is committed even if local cleanup or a subsequent refresh fails.
    // Report that failure separately rather than inviting a destructive retry.
    try {
      await input.onSuccess();
    } catch (error) {
      input.onError(new Error(t("app.sessionDeletedRefreshFailed", {
        error: error instanceof Error ? error.message : String(error),
      })));
    }
    return "deleted";
  } catch (error) {
    input.onError(error);
    return "failed";
  }
}
