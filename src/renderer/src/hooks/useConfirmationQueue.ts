import { useEffect, useRef, useState } from "react";
import { createConfirmationQueue, type ConfirmDialogConfig } from "../utils/confirmationQueue";

/** Component-owned confirmation lifecycle shared by desktop overlays and standalone Web. */
export function useConfirmationQueue() {
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogConfig | null>(null);
  const queueRef = useRef<ReturnType<typeof createConfirmationQueue> | null>(null);
  if (!queueRef.current) queueRef.current = createConfirmationQueue(setConfirmDialog);
  const queue = queueRef.current;
  useEffect(() => {
    queue.activate();
    return () => queue.dispose();
  }, [queue]);
  return { confirmDialog, showConfirm: queue.showConfirm, clearConfirm: queue.clearConfirm };
}
