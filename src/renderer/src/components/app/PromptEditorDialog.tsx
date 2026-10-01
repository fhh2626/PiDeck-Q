import { X } from "lucide-react";
import { t } from "../../i18n";
import { Button } from "../ui-shadcn/button";
import { Dialog, DialogContent, DialogTitle } from "../ui-shadcn/dialog";
import { CodeMirrorEditor } from "./CodeMirrorEditor";

/** Portaled editor: nested settings/project dialogs must not clip or trap its input. */
export function PromptEditorDialog({ title, content, loading, hint, onChange, onClose }: {
	title: string;
	content: string;
	loading: boolean;
	hint?: string;
	onChange: (value: string) => void;
	onClose: () => void;
}) {
	return (
		<Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
			<DialogContent showCloseButton={false} aria-describedby={undefined}
				className="flex h-[min(600px,calc(100dvh-48px))] w-[min(800px,calc(100vw-48px))] max-w-none flex-col gap-0 overflow-hidden rounded-lg border-0 bg-bg-panel p-0 shadow-xl sm:max-w-none">
				<div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border-subtle bg-bg-muted pr-4 pl-6">
					<div className="flex min-w-0 items-center gap-2">
						<DialogTitle className="truncate text-control font-medium">{title}</DialogTitle>
						{hint && <span className="text-caption text-text-tertiary">{hint}</span>}
					</div>
					<Button variant="ghost" size="icon" aria-label={t("common.close")} title={t("common.close")} onClick={onClose}>
						<X size={18} strokeWidth={2.2} aria-hidden="true" />
					</Button>
				</div>
				{loading ? (
					<div className="py-12 text-center text-control text-text-tertiary">{t("common.loading")}</div>
				) : (
					<div className="min-h-0 w-full flex-1 overflow-hidden">
						<CodeMirrorEditor value={content} onChange={onChange} />
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
}
