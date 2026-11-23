export interface ConfirmDialogConfig {
  title: string;
  message: string;
  onConfirm: () => void;
  onCancel?: () => void;
  danger?: boolean;
  confirmLabel?: string;
}

/** One owner queues dialogs and fences callbacks by identity, including stale DOM events. */
export function createConfirmationQueue(publish: (dialog: ConfirmDialogConfig | null) => void) {
  let nextId = 0;
  let disposed = false;
  let invoking: number | undefined;
  const entries: { id: number; config: ConfirmDialogConfig }[] = [];

  function render() {
    const current = entries[0];
    publish(current ? {
      ...current.config,
      onConfirm: () => settle(current.id, true),
      onCancel: () => settle(current.id, false),
    } : null);
  }

  function settle(id: number, confirmed: boolean) {
    if (entries[0]?.id !== id) return;
    const current = entries.shift();
    if (!current) return;
    render();
    invoking = id;
    try {
      if (confirmed) current.config.onConfirm();
      else current.config.onCancel?.();
    } finally {
      invoking = undefined;
    }
  }

  return {
    showConfirm(config: ConfirmDialogConfig) {
      if (disposed) { config.onCancel?.(); return; }
      entries.push({ id: ++nextId, config });
      if (entries.length === 1) render();
    },
    clearConfirm() {
      // Legacy onConfirm callbacks call clearConfirm themselves. Their entry was
      // already settled, so never let that call dismiss the next queued operation.
      if (invoking === undefined && entries[0]) settle(entries[0].id, false);
    },
    activate() { disposed = false; },
    dispose() {
      disposed = true;
      const cancelled = entries.splice(0);
      for (const entry of cancelled) entry.config.onCancel?.();
    },
  };
}
