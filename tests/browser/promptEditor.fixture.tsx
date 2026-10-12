import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui-shadcn/dialog";
import { PromptsTab } from "@/config/PromptsTab";
import { usePromptTemplateEditor } from "@/hooks/usePromptTemplateEditor";
import { setI18nLocale } from "@/i18n";
import type { PiPromptTemplateSummary } from "@shared/types";

setI18nLocale("en-US");
const template: PiPromptTemplateSummary = {
	name: "editable", path: "/prompts/editable.md", description: "User template",
	content: "Template body", userCreated: true,
};

/** A deliberately small, transformed settings dialog reproduces clipping and stacking. */
function Fixture() {
	const [open, setOpen] = useState(true);
	const editor = usePromptTemplateEditor({ storage: { read: async () => template.content, write: async () => {} } });
	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogContent data-testid="settings" aria-describedby={undefined}
				className="h-[450px] w-[520px] overflow-hidden p-0" showCloseButton={false}>
				<DialogTitle>Settings fixture</DialogTitle>
				<PromptsTab data={{ templates: [template], globalDir: "/prompts", hasHiddenBuiltins: false }}
					loading={false} creating={false} newName="" newDescription="" editor={editor}
					canRestoreBuiltins={false} restoringBuiltins={false}
					onRefresh={() => {}} onOpenRoot={() => {}} onRestoreBuiltins={() => {}}
					onChangeNewName={() => {}} onChangeNewDescription={() => {}} onCreate={() => {}}
					onDelete={() => {}} onRename={async () => {}} />
			</DialogContent>
		</Dialog>
	);
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<Fixture />);
