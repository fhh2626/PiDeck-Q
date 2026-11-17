import { useState, useMemo } from "react";
import { desktopApi as api } from "../desktopApi";
import { useConfirmationQueue } from "./useConfirmationQueue";

interface TrustRequest {
  requestId: string;
  cwd: string;
  projectName: string;
}

export function useOverlayActions() {
  const { confirmDialog, showConfirm, clearConfirm } = useConfirmationQueue();
  const [trustRequest, setTrustRequest] = useState<TrustRequest | null>(null);

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
    trust: trustRequest ? {
      open: true as const,
      requestId: trustRequest.requestId,
      cwd: trustRequest.cwd,
      projectName: trustRequest.projectName,
      onChoose: (choice: "trust-remember" | "trust-session" | "deny") => {
        api.projects.respondTrustRequest(trustRequest.requestId, choice);
        setTrustRequest(null);
      },
    } : undefined,
  }), [confirmDialog, trustRequest, clearConfirm]);

  return {
    confirmDialog,
    showConfirm,
    clearConfirm,
    trustRequest,
    setTrustRequest,
    overlayProps,
  };
}
