import { useRef, useState } from "react";
import { X } from "lucide-react";
import { t } from "../../i18n";
import type { PromptTemplateEditor } from "../../hooks/usePromptTemplateEditor";
import { Alert, AlertDescription } from "../ui-shadcn/alert";
import { Button } from "../ui-shadcn/button";
import { ConfirmDialog } from "../ui-shadcn/ConfirmDialog";
import { Dialog, DialogContent, DialogFooter, DialogTitle } from "../ui-shadcn/dialog";
import { CodeMirrorEditor } from "./CodeMirrorEditor";

/** Portaled editor owns its chrome; the domain hook owns all read/save/draft state. */
export function PromptEditorDialog({ editor }: { editor: PromptTemplateEditor }) {
	const [confirmClose, setConfirmClose] = useState(false);
	const dialogRef = useRef<HTMLDivElement>(null);
	const { state, dirty } = editor;
	// Saving disables the toolbar buttons. Move button focus inside the dialog
	// before disabling them, rather than leaving BODY/obscured settings focused.
	// An already-focused CodeMirror keeps its caret and keyboard focus unchanged.
	const saveKeepingFocus = () => {
		if (dirty && !state.saving && document.activeElement instanceof HTMLButtonElement
			&& dialogRef.current?.contains(document.activeElement)) {
			dialogRef.current.focus({ preventScroll: true });
		}
		void editor.save();
	};
	const requestClose = () => {
		if (state.saving) return;
		if (dirty) setConfirmClose(true);
		else editor.close();
	};
	return (
		// React capture follows both portals, including the sibling confirmation.
		// Keep this shortcut modal-local instead of intercepting other open dialogs.
		<div className="contents" onKeyDownCapture={(event) => {
			if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
				event.preventDefault();
				event.stopPropagation();
				if (!confirmClose) saveKeepingFocus();
			}
		}}>
		<Dialog open onOpenChange={(open) => { if (!open) requestClose(); }}>
			<DialogContent ref={dialogRef} showCloseButton={false} aria-describedby={undefined}
				onEscapeKeyDown={(event) => { if (state.saving) event.preventDefault(); }}
				className="flex h-[min(600px,calc(100dvh-48px))] w-[min(800px,calc(100vw-48px))] max-w-none flex-col gap-0 overflow-hidden rounded-lg border-0 bg-bg-panel p-0 shadow-xl sm:max-w-none">
				<div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border-subtle bg-bg-muted pr-4 pl-6">
					<DialogTitle className="truncate text-control font-medium">{state.template?.name}.md</DialogTitle>
					<Button variant="ghost" size="icon" disabled={state.saving} aria-label={t("common.close")} title={t("common.close")} onClick={requestClose}>
						<X size={18} strokeWidth={2.2} aria-hidden="true" />
					</Button>
				</div>
				{state.error && (
					<Alert variant="destructive" className="max-h-24 shrink-0 overflow-y-auto rounded-none border-x-0 border-t-0">
						<AlertDescription className="break-words">{state.error}</AlertDescription>
					</Alert>
				)}
				{state.loading ? (
					<div className="min-h-0 flex-1 py-12 text-center text-control text-text-tertiary">{t("common.loading")}</div>
				) : (
					<div className="min-h-0 w-full flex-1 overflow-hidden">
						<CodeMirrorEditor value={state.content} onChange={editor.change} readOnly={!state.ready || state.saving} />
					</div>
				)}
				<DialogFooter className="shrink-0 flex-row items-center gap-2 border-t border-border-subtle px-4 py-3">
					<div className="mr-auto min-w-0 text-caption text-text-tertiary">
						<div className="truncate">{t("config.promptEditorShortcut")}</div>
						<div role="status" aria-live="polite" className="min-h-4 text-text-secondary">
							{state.saving ? t("common.saving") : dirty ? t("config.dirtyTooltip") : state.saved ? t("config.promptSavedHint") : null}
						</div>
					</div>
					<Button variant="outline" disabled={state.saving} onClick={requestClose}>{t("common.close")}</Button>
					<Button disabled={state.loading || !state.ready || state.saving || !dirty} onClick={saveKeepingFocus}>
						{state.saving ? t("common.saving") : t("common.save")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
		{confirmClose && (
			<ConfirmDialog title={t("config.unsavedTitle")} message={t("config.promptEditorDiscardMessage")}
				confirmLabel={t("config.discardChanges")} danger
				onCancel={() => setConfirmClose(false)}
				onConfirm={() => { setConfirmClose(false); editor.close(); }} />
		)}
		</div>
	);
}
