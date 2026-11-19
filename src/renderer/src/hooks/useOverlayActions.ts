import { useMemo } from "react";
import { useConfirmationQueue } from "./useConfirmationQueue";

export function useOverlayActions() {
  const { confirmDialog, showConfirm, clearConfirm } = useConfirmationQueue();

  const overlayProps = useMemo(() => ({
    confirm: confirmDialog ? {
      open: true as const,
      props: {
        title: confirmDialog.title,
        message: confirmDialog.message,
        onConfirm: confirmDialog.onConfirm,
        onCancel: confirmDialog.onCancel ?? clearConfirm,
        danger: confirmDialog.danger,
        confirmLabel: confirmDialog.confirmLabel,
      },
    } : undefined,
  }), [confirmDialog, clearConfirm]);

  return {
    confirmDialog,
    showConfirm,
    clearConfirm,
    overlayProps,
  };
}
