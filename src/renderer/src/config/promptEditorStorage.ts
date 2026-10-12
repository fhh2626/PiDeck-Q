import type { PiDesktopApi } from "../../../shared/desktop/createPiDesktopApi";
import type { PromptEditorStorage } from "../hooks/usePromptTemplateEditor";
import { t } from "../i18n";

/** Global built-ins are read in memory and copied once before their first write. */
export function createGlobalPromptEditorStorage(api: Pick<PiDesktopApi["prompts"], "edit" | "create">): PromptEditorStorage {
	return {
		read: async (template) => {
			if (!template.userCreated) return template.content;
			const content = await api.edit(template.path);
			if (typeof content !== "string") throw new Error(t("config.loadFailed"));
			return content;
		},
		createCopy: (template) => api.create({ name: template.name, description: template.description }),
		write: async (template, content) => { await api.edit(template.path, content); },
	};
}

/** Project prompts keep their project-scoped file identity on every save. */
export function createProjectPromptEditorStorage(api: Pick<PiDesktopApi["files"], "readContent" | "writeContent">): PromptEditorStorage {
	return {
		read: (template) => api.readContent(template.path),
		write: (template, content) => api.writeContent(template.path, content),
	};
}
