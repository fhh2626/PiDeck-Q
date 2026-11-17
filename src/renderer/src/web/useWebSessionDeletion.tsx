import { ConfirmDialog } from "../components/ui-shadcn/ConfirmDialog";
import { deleteSessionWithConfirmation } from "../hooks/deleteSessionWithConfirmation";
import { useConfirmationQueue } from "../hooks/useConfirmationQueue";
import { deleteSession } from "./webApi";
import type { WebSession } from "./webTypes";

/** Standalone Web uses the same authorization lifecycle as desktop session deletion. */
export function useWebSessionDeletion(input: {
  sessions: WebSession[];
  onDeleted: (sessionId: string) => void | Promise<void>;
  onError: (error: string | null) => void;
}) {
  const { confirmDialog, showConfirm, clearConfirm } = useConfirmationQueue();
  return {
    async handleDeleteSession(sessionId: string) {
      input.onError(null);
      const sessionTitle = input.sessions.find((session) => session.id === sessionId)?.title || sessionId;
      await deleteSessionWithConfirmation({
        sessionId, sessionTitle, deleteRecord: deleteSession, showConfirm, clearConfirm,
        onSuccess: () => input.onDeleted(sessionId),
        onError: (error) => input.onError(error instanceof Error ? error.message : String(error)),
      });
    },
    confirmation: confirmDialog ? <ConfirmDialog {...confirmDialog} onCancel={confirmDialog.onCancel ?? clearConfirm} /> : null,
  };
}
