import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { createPreviewApi } from "@/previewApi";
import { setI18nLocale } from "@/i18n";
import { TooltipProvider } from "@/components/ui-shadcn/tooltip";
import type { PiPromptTemplateSummary, Project } from "@shared/types";

setI18nLocale("en-US");
const params = new URLSearchParams(window.location.search);
const projectScope = params.get("scope") === "project";
let template: PiPromptTemplateSummary = {
	name: "editable", path: params.get("builtin") === "1" ? "builtin://editable" : projectScope ? "/project/.pi/prompts/editable.md" : "/prompts/editable.md",
	description: "Editable template", content: "Template body", userCreated: params.get("builtin") !== "1",
};
const project: Project = { id: "project", name: "Project fixture", path: "/project", lastOpenedAt: 1 };

/** Controlled storage requests let Playwright test the real hosts without disk or IPC. */
async function readContent(path: string): Promise<string> {
	const response = await fetch(`/prompt-editor-test/read?path=${encodeURIComponent(path)}`);
	if (!response.ok) throw new Error(await response.text());
	return response.text();
}
async function writeContent(path: string, content: string): Promise<void> {
	const response = await fetch("/prompt-editor-test/write", {
		method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, content }),
	});
	if (!response.ok) throw new Error(await response.text());
	template = { ...template, content };
}

const api = createPreviewApi();
window.piDesktop = {
	...api,
	files: { ...api.files, readContent, writeContent },
	projectResources: { ...api.projectResources, list: async () => ({ skills: [], extensions: [] }) },
	prompts: {
		...api.prompts,
		list: async () => ({ templates: [template], globalDir: "/prompts", hasHiddenBuiltins: false }),
		listByProject: async () => ({ templates: [template], globalDir: "/project/.pi/prompts", hasHiddenBuiltins: false }),
		edit: async (path, content) => content === undefined ? readContent(path) : writeContent(path, content),
		create: async () => {
			const response = await fetch("/prompt-editor-test/create", { method: "POST" });
			if (!response.ok) throw new Error(await response.text());
			// Match PromptManager.create: the same name becomes a user file containing
			// only frontmatter. The original builtin body has not been persisted yet.
			template = { ...template, path: "/prompts/editable.md", content: `---\ndescription: ${template.description}\n---\n`, userCreated: true };
			return template;
		},
	},
};
// Set the last page before importing ConfigModal (desktopApi captures the fixture API).
localStorage.setItem("pideck-config-last-tab", "prompts");

/** Both entry points are production components, including their save/read wiring. */
async function mount() {
	const [{ ConfigModal }, { ProjectResourcesModal }] = await Promise.all([
		import("@/ConfigModal"), import("@/components/app/ProjectResourcesModal"),
	]);
	function Fixture() {
		const [open, setOpen] = useState(true);
		return <TooltipProvider>{projectScope
			? open && <ProjectResourcesModal project={project} onClose={() => setOpen(false)} />
			: <ConfigModal open={open} onClose={() => setOpen(false)} onSaved={() => {}} />}
		</TooltipProvider>;
	}
	const root = document.getElementById("root");
	if (root) createRoot(root).render(<Fixture />);
}
void mount().catch((error: unknown) => { document.body.textContent = String(error); });
