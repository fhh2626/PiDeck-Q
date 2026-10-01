import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui-shadcn/dialog";
import { PromptsTab } from "@/config/PromptsTab";
import type { PiPromptTemplateSummary } from "@shared/types";

const template: PiPromptTemplateSummary = {
	name: "editable", path: "/prompts/editable.md", description: "User template",
	content: "Template body", userCreated: true,
};

/** A deliberately small, transformed settings dialog reproduces clipping and stacking. */
function Fixture() {
	const [open, setOpen] = useState(true);
	const [editing, setEditing] = useState<PiPromptTemplateSummary | null>(null);
	const [content, setContent] = useState(template.content);
	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogContent data-testid="settings" aria-describedby={undefined}
				className="h-[450px] w-[520px] overflow-hidden p-0" showCloseButton={false}>
				<DialogTitle>Settings fixture</DialogTitle>
				<PromptsTab data={{ templates: [template], globalDir: "/prompts", hasHiddenBuiltins: false }}
					loading={false} creating={false} newName="" newDescription=""
					editingTemplate={editing} editContent={content} editLoading={false} editSaving={false}
					canRestoreBuiltins={false} restoringBuiltins={false}
					onRefresh={() => {}} onOpenRoot={() => {}} onRestoreBuiltins={() => {}}
					onChangeNewName={() => {}} onChangeNewDescription={() => {}} onCreate={() => {}}
					onDelete={() => {}} onEdit={setEditing} onRename={async () => {}}
					onCancelEdit={() => setEditing(null)} onQuickSave={() => {}}
					onChangeEditContent={setContent} onSaveEdit={() => {}} />
			</DialogContent>
		</Dialog>
	);
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<Fixture />);
