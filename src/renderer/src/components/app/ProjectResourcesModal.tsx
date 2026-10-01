import { Button } from "../ui-shadcn/button";
import { useCallback, useEffect, useMemo, useState } from "react";
import { showNotice } from "../../utils/notice";

import { Check, Code2, FileEdit, FolderOpen, MessageSquareText, Pencil, Puzzle, RefreshCw, ToggleLeft, ToggleRight, Trash2, X } from "lucide-react";
import { CodeMirrorEditor } from "../app/CodeMirrorEditor";
import { PromptEditorDialog } from "./PromptEditorDialog";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "../ui-shadcn/dialog";
import { ConfirmDialog } from "../ui-shadcn/ConfirmDialog";
import type {
	PiExtensionSummary,
	PiPromptTemplateSummary,
	PiSkillSummary,
	Project,
	ProjectResourceListResult,
} from "../../../../shared/types";
import { t } from "../../i18n";
import { Input } from "../ui-shadcn/input";
import { Textarea } from "../ui-shadcn/textarea";
import { Label } from "../../components/ui-shadcn/label";
import { Alert, AlertDescription } from "../ui-shadcn/alert";
import { Badge } from "../ui-shadcn/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui-shadcn/card";
import { ScrollArea } from "../ui-shadcn/scroll-area";
import { Tabs, TabsList, TabsTrigger } from "../ui-shadcn/tabs";

type ProjectResourcesApi = typeof window.piDesktop.projectResources;

type ProjectResourceTab = "skills" | "extensions" | "prompts";

type DeleteTarget =
	| { kind: "skill"; item: PiSkillSummary }
	| { kind: "extension"; item: PiExtensionSummary }
	| { kind: "prompt"; item: PiPromptTemplateSummary };

export function ProjectResourcesModal(props: {
	project: Project;
	onClose: () => void;
}) {
	const [data, setData] = useState<ProjectResourceListResult>({ skills: [], extensions: [] });
	const [prompts, setPrompts] = useState<PiPromptTemplateSummary[]>([]);
	const [promptsLoading, setPromptsLoading] = useState(false);
	const [loading, setLoading] = useState(true);
	const [createBusy, setCreateBusy] = useState(false);
	const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
	const [deleteBusy, setDeleteBusy] = useState(false);
	const [activeTab, setActiveTab] = useState<ProjectResourceTab>("skills");
	const [newName, setNewName] = useState("");
	const [newDescription, setNewDescription] = useState("");
	// 项目 prompt 创建状态
	const [newPromptName, setNewPromptName] = useState("");
	const [newPromptDescription, setNewPromptDescription] = useState("");
	const [creatingPrompt, setCreatingPrompt] = useState(false);
	// 项目 prompt 编辑器状态
	const [editingProjectPrompt, setEditingProjectPrompt] = useState<PiPromptTemplateSummary | null>(null);
	const [editProjectPromptContent, setEditProjectPromptContent] = useState("");
	const [editProjectPromptLoading, setEditProjectPromptLoading] = useState(false);
	const [editProjectPromptSaving, setEditProjectPromptSaving] = useState(false);
	const [editProjectPromptSaved, setEditProjectPromptSaved] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// 内建编辑器状态
	const [editingSkill, setEditingSkill] = useState<PiSkillSummary | null>(null);
	const [editContent, setEditContent] = useState("");
	const [editLoading, setEditLoading] = useState(false);
	const [editSaving, setEditSaving] = useState(false);
	const [editSaved, setEditSaved] = useState(false);
	// 项目 skill 重命名状态
	const [renamingSkill, setRenamingSkill] = useState<string | null>(null);
	const [renameSkillValue, setRenameSkillValue] = useState("");
	const [renameSkillBusy, setRenameSkillBusy] = useState(false);
	const api = (window as unknown as { piDesktop: { projectResources: ProjectResourcesApi } }).piDesktop.projectResources;

	const refresh = useMemo(
		() => async (showToast?: boolean) => {
			setLoading(true);
			setError(null);
			try {
				setData(await api.list(props.project.id));
				if (showToast) showNotice(t("projectResources.refreshed"), 2000);
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			} finally {
				setLoading(false);
			}
		},
		[props.project.id],
	);

	/** 加载项目级提示词模板 */
	const loadPrompts = useCallback(async () => {
		setPromptsLoading(true);
		setError(null);
		try {
			const result = await window.piDesktop.prompts.listByProject(props.project.path);
			setPrompts(result.templates);
		} catch (err) {
			setPrompts([]);
		}
		setPromptsLoading(false);
	}, [props.project.path]);

	/** 进入提示词 tab 时自动加载 */
	useEffect(() => {
		if (activeTab === "prompts") {
			void loadPrompts();
		}
	}, [activeTab, loadPrompts]);

	useEffect(() => {
		void refresh();
		void loadPrompts();
	}, [refresh, loadPrompts]);

	const canCreateSkill = useMemo(
		() => newName.trim().length > 0 && newDescription.trim().length > 0,
		[newName, newDescription],
	);

	const createSkill = async () => {
		if (!canCreateSkill || createBusy) return;
		setCreateBusy(true);
		setError(null);
		try {
			await api.createSkill({
				projectId: props.project.id,
				name: newName.trim(),
				description: newDescription.trim(),
			});
			setNewName("");
			setNewDescription("");
			await refresh();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setCreateBusy(false);
		}
	};

	const confirmDelete = async () => {
		if (!deleteTarget || deleteBusy) return;
		setDeleteBusy(true);
		setError(null);
		try {
			if (deleteTarget.kind === "skill") {
				await api.deleteSkill(props.project.id, deleteTarget.item.path);
			} else if (deleteTarget.kind === "extension" && deleteTarget.item.path) {
				await api.deleteExtension(props.project.id, deleteTarget.item.path);
			} else if (deleteTarget.kind === "prompt") {
				// 用文件名删除项目级 prompt
				const fileName = deleteTarget.item.path.split(/[/\\]/).pop();
				if (fileName) {
					await window.piDesktop.prompts.deleteFromProject(props.project.path, fileName);
				}
			}
			setDeleteTarget(null);
			await Promise.all([refresh(), loadPrompts()]);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setDeleteBusy(false);
		}
	};

	// Ctrl+S / Cmd+S 快捷键保存
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (!(e.ctrlKey || e.metaKey) || e.key !== "s") return;
			if (editingSkill && !editSaving) {
				e.preventDefault();
				void saveEditor();
			} else if (editingProjectPrompt && !editProjectPromptSaving) {
				e.preventDefault();
				void saveProjectPromptEditor();
			}
		};
		if (editingSkill || editingProjectPrompt) {
			window.addEventListener("keydown", handleKeyDown);
			return () => window.removeEventListener("keydown", handleKeyDown);
		}
	}, [editingSkill, editingProjectPrompt, editSaving, editProjectPromptSaving]);

	/** 打开内建编辑器：读取 SKILL.md 内容 */
	const openEditor = async (skill: PiSkillSummary) => {
		setEditingSkill(skill);
		setEditContent("");
		setEditSaved(false);
		setEditLoading(true);
		setError(null);
		try {
			const content = await window.piDesktop.files.readContent(skill.path);
			setEditContent(content);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setEditingSkill(null);
		} finally {
			setEditLoading(false);
		}
	};

	/** 保存编辑内容到 SKILL.md */
	const saveEditor = async () => {
		if (!editingSkill || editSaving) return;
		setEditSaving(true);
		setError(null);
		try {
			await window.piDesktop.files.writeContent(editingSkill.path, editContent);
			setEditSaved(true);
			window.setTimeout(() => setEditSaved(false), 2000);
			// 保存后刷新列表，让 readSkill 读到最新 frontmatter
			await refresh();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setEditSaving(false);
		}
	};

	/** 重命名项目 Skill */
	const renameSkillConfirm = async (skill: PiSkillSummary, newName: string) => {
		if (renameSkillBusy || !newName.trim() || newName.trim() === skill.name) {
			setRenamingSkill(null);
			return;
		}
		setRenameSkillBusy(true);
		setError(null);
		try {
			await api.renameSkill(props.project.id, skill.path, newName.trim());
			await refresh();
			setRenamingSkill(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setRenameSkillBusy(false);
		}
	};

	/** 切换 Skill 启用/禁用 */
	const toggleSkill = async (skill: PiSkillSummary) => {
		const nextEnabled = !skill.enabled;
		try {
			const updated = await api.toggleSkill(props.project.id, skill.path, nextEnabled);
			// 直接更新列表中对应的 skill，避免全量刷新加载闪烁
			setData((prev) => ({
				...prev,
				skills: prev.skills.map((s) => (s.id === skill.id ? updated : s)),
			}));
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	};

	const toggleExtension = async (extension: PiExtensionSummary) => {
		const nextEnabled = extension.enabled !== false ? false : true;
		try {
			await api.toggleExtension(props.project.id, extension.path!, nextEnabled);
			setData((prev) => ({
				...prev,
				extensions: prev.extensions.map((e) =>
					e.id === extension.id ? { ...e, enabled: nextEnabled } : e
				),
			}));
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	};

	// ── 项目级 prompt 操作 ──

	const canCreatePrompt = newPromptName.trim().length > 0 && newPromptDescription.trim().length > 0;

	const createProjectPrompt = async () => {
		if (!canCreatePrompt || creatingPrompt) return;
		setCreatingPrompt(true);
		setError(null);
		try {
			await window.piDesktop.prompts.createInProject(props.project.path, {
				name: newPromptName.trim(),
				description: newPromptDescription.trim(),
			});
			setNewPromptName("");
			setNewPromptDescription("");
			await loadPrompts();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setCreatingPrompt(false);
		}
	};

	const openProjectPromptEditor = async (prompt: PiPromptTemplateSummary) => {
		setEditingProjectPrompt(prompt);
		setEditProjectPromptContent("");
		setEditProjectPromptLoading(true);
		setEditProjectPromptSaved(false);
		setError(null);
		try {
			const content = await window.piDesktop.files.readContent(prompt.path);
			setEditProjectPromptContent(content);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setEditingProjectPrompt(null);
		} finally {
			setEditProjectPromptLoading(false);
		}
	};

	const saveProjectPromptEditor = async () => {
		if (!editingProjectPrompt || editProjectPromptSaving) return;
		setEditProjectPromptSaving(true);
		setError(null);
		try {
			await window.piDesktop.files.writeContent(editingProjectPrompt.path, editProjectPromptContent);
			setEditProjectPromptSaved(true);
			window.setTimeout(() => setEditProjectPromptSaved(false), 2000);
			await loadPrompts();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setEditProjectPromptSaving(false);
		}
	};

	const cancelProjectPromptEditor = () => {
		setEditingProjectPrompt(null);
		setEditProjectPromptContent("");
	};

	return (
		<>
		<Dialog open onOpenChange={(next) => !next && props.onClose()}>
			<DialogContent
				showCloseButton={false}
				stagger
				className="project-resources-dialog flex h-[min(760px,calc(100vh-32px))] flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(1120px,calc(100vw-32px))] [--wallpaper-dialog-alpha:var(--wallpaper-panel-alpha,30%)]"
			>
				<DialogHeader className="shrink-0 gap-1 border-b border-border-subtle px-6 py-4 text-left">
					<div className="flex items-start justify-between gap-4">
						<div className="min-w-0">
							<DialogTitle className="flex items-center gap-2 text-base">
								<span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
									<FolderOpen data-icon="inline-start" aria-hidden="true" />
								</span>
								{t("projectResources.title")}
							</DialogTitle>
							<DialogDescription className="mt-1 truncate font-mono text-micro" title={props.project.path}>
								{props.project.path}
							</DialogDescription>
						</div>
						<DialogClose asChild>
							<Button variant="ghost" size="icon" aria-label={t("common.close")} title={t("common.close")}>
								<X data-icon="inline-start" aria-hidden="true" />
							</Button>
						</DialogClose>
					</div>
				</DialogHeader>

				<Tabs
					value={activeTab}
					onValueChange={(value) => {
						if (value === "skills" || value === "extensions" || value === "prompts") {
							setActiveTab(value);
							if (value === "skills") setEditingSkill(null);
						}
					}}
					className="min-h-0 flex-1 gap-0"
				>
					<div className="flex shrink-0 items-center justify-between gap-4 border-b border-border-subtle px-6 py-2">
						<TabsList className="h-auto w-full min-w-0 flex-1 border-0 bg-transparent p-0">
							<TabsTrigger value="skills" className="gap-1.5 px-3 py-2 text-control">
								<Code2 data-icon="inline-start" aria-hidden="true" />
								{t("projectResources.skillsTab", { count: data.skills.length })}
							</TabsTrigger>
							<TabsTrigger value="extensions" className="gap-1.5 px-3 py-2 text-control">
								<Puzzle data-icon="inline-start" aria-hidden="true" />
								{t("projectResources.extensionsTab", { count: data.extensions.length })}
							</TabsTrigger>
							<TabsTrigger value="prompts" className="gap-1.5 px-3 py-2 text-control">
								<MessageSquareText data-icon="inline-start" aria-hidden="true" />
								{t("projectResources.promptsTab", { count: prompts.length })}
							</TabsTrigger>
						</TabsList>
						<Button variant="outline" size="sm" onClick={() => void refresh(true)} disabled={loading}>
							<RefreshCw data-icon="inline-start" aria-hidden="true" className={loading ? "animate-spin" : undefined} />
							{t("common.refresh")}
						</Button>
					</div>

					{error && (
						<Alert variant="destructive" className="mx-6 mt-3 shrink-0">
							<AlertDescription className="break-words">{error}</AlertDescription>
						</Alert>
					)}

				<ScrollArea className="min-h-0 flex-1">
				{editingSkill ? (
					<div className="prompts-editor-backdrop" onClick={() => setEditingSkill(null)}>
						<div className="prompts-editor-modal" onClick={(e) => e.stopPropagation()}>
							<div className="file-diff-header">
								<span className="file-diff-header-file">{editingSkill.name} · SKILL.md</span>
								<div className="file-diff-header-actions">
									<Button variant="ghost" size="icon-sm" onClick={() => setEditingSkill(null)} aria-label={t("common.close")} title={t("common.close")}>
										<X size={16} />
									</Button>
								</div>
							</div>
							{editLoading ? (
								<div className="py-12 text-center text-[13px] text-text-tertiary">{t("common.loading")}</div>
							) : (
								<div className="prompts-monaco-wrap">
									<CodeMirrorEditor
										value={editContent}
										onChange={setEditContent}
									/>
								</div>
							)}
							{editSaved && <span className="file-diff-hint saved">{t("config.promptSavedHint")}</span>}
						</div>
					</div>
				) : activeTab === "skills" ? (
					<div className="project-resources-body">
						<Card className="project-skill-create">
							<CardHeader className="gap-1 px-0 py-0">
								<CardTitle className="text-sm">{t("projectResources.createSkill")}</CardTitle>
								<CardDescription>{t("projectResources.createSkillHint")}</CardDescription>
							</CardHeader>
							<CardContent className="grid gap-3 px-0 pb-0">
								{/* 两列宽度保证中文字段名完整显示，同时把输入控件的剩余空间固定留给内容。 */}
								<Label className="project-resources-name-field grid w-full grid-cols-[4rem_minmax(0,1fr)] items-center gap-2">
									<span>{t("config.name")}</span>
									<Input value={newName} placeholder="my-project-skill" onChange={(event) => setNewName(event.target.value)} />
								</Label>
								<Label className="project-resources-desc-field grid w-full grid-cols-[4rem_minmax(0,1fr)] items-start gap-2">
									<span className="pt-2">{t("config.description")}</span>
									<Textarea value={newDescription} placeholder="Use when..." onChange={(event) => setNewDescription(event.target.value)} />
								</Label>
								<Button variant="default" onClick={createSkill} disabled={!canCreateSkill || createBusy}>
									<Code2 data-icon="inline-start" aria-hidden="true" />
									{createBusy ? t("projectResources.creatingSkillAction") : t("projectResources.createSkillAction")}
								</Button>
							</CardContent>
						</Card>
						<div className="project-resources-list-header">
							<strong>{t("projectResources.skillsTab", { count: data.skills.length })}</strong>
							<Badge variant="secondary">{data.skills.length}</Badge>
						</div>
						<div className="project-resources-list-section">
						<ResourceListEmpty loading={loading} empty={data.skills.length === 0} label={t("projectResources.emptySkills")} />
						{data.skills.map((skill) => (
							<article key={skill.id} className="project-resource-card">
								<button
									type="button"
									className="project-resource-info"
									onClick={() => void openEditor(skill)}
									title={t("common.edit")}
								>
									<div className="project-resource-title">
										{renamingSkill === skill.id ? (
											<div className="skill-rename-inline">
												<Input
											value={renameSkillValue}
											onChange={(e) => setRenameSkillValue(e.target.value)}
													onKeyDown={(e) => { if (e.key === "Enter") void renameSkillConfirm(skill, renameSkillValue); if (e.key === "Escape") setRenamingSkill(null); }}
													autoFocus
													disabled={renameSkillBusy}
												/>
												{/* 内联行内按钮用 icon-xs（24px），避免 icon-sm 32px 撑高 28px 输入行 */}
												<Button variant="ghost" size="icon-xs" onClick={() => void renameSkillConfirm(skill, renameSkillValue)} disabled={renameSkillBusy} title={t("common.confirm")}>
													<Check size={14} strokeWidth={2} />
												</Button>
												<Button variant="ghost" size="icon-xs" onClick={() => setRenamingSkill(null)} disabled={renameSkillBusy} title={t("common.cancel")}>
													<X size={14} strokeWidth={2} />
												</Button>
											</div>
										) : (
											<strong>{skill.name}</strong>
										)}
										<span className="flex items-center gap-1">
											<Badge variant={skill.enabled ? "secondary" : "outline"}>
												{skill.enabled ? t("common.enabled") : t("common.disabled")}
											</Badge>
											{!skill.valid && <Badge variant="destructive">{t("config.needsFix")}</Badge>}
										</span>
									</div>
									<small>{skill.description || t("config.skillDescriptionMissing")}</small>
								<small>{skill.sourceLabel} · {skill.path}</small>
								</button>
								<div className="skill-card-actions project-resource-actions">
									{/* 操作入口保持常驻，删除/编辑不依赖 hover；shadcn ghost 图标按钮统一尺寸 */}
									<Button
										variant="ghost"
										size="icon-sm"
										onClick={() => void openEditor(skill)}
										title={t("common.edit")}
									>
										<Pencil size={14} strokeWidth={1.8} />
									</Button>
									<Button
										variant="ghost"
										size="icon-sm"
										onClick={() => { setRenamingSkill(skill.id); setRenameSkillValue(skill.name); }}
										title={t("common.rename")}
									>
										<FileEdit size={14} strokeWidth={1.8} />
									</Button>
									<Button
										variant="ghost"
										size="icon-sm"
										onClick={() => void toggleSkill(skill)}
										title={skill.enabled ? t("common.disable") : t("common.enabled")}
										style={skill.enabled ? { color: "var(--color-accent)" } : undefined}
									>
										{skill.enabled ? <ToggleRight size={18} strokeWidth={1.8} /> : <ToggleLeft size={18} strokeWidth={1.8} />}
									</Button>
									<Button
										variant="ghost"
										size="icon-sm"
										className="text-destructive hover:bg-destructive/10 hover:text-destructive"
										onClick={() => setDeleteTarget({ kind: "skill", item: skill })}
										title={t("common.delete")}
									>
										<Trash2 size={14} strokeWidth={1.8} />
									</Button>
								</div>
							</article>
						))}
						</div>
					</div>
				) : activeTab === "extensions" ? (
					<div className="project-resources-body">
						<div className="project-resources-list-header col-span-2">
							<strong>{t("projectResources.extensionsTab", { count: data.extensions.length })}</strong>
							<Badge variant="secondary">{data.extensions.length}</Badge>
						</div>
						<div className="project-resources-list-section">
							<ResourceListEmpty loading={loading} empty={data.extensions.length === 0} label={t("projectResources.emptyExtensions")} />
						{data.extensions.map((extension) => (
							<article key={extension.id} className="project-resource-card">
								<div className="project-resource-info">
									<div className="project-resource-title">
										<strong>{extension.source}</strong>
										<Badge variant={extension.enabled === false ? "outline" : "secondary"}>
											{extension.enabled !== false ? t("common.enabled") : t("common.disabled")}
										</Badge>
										<Badge variant="outline">{t("projectResources.projectScope")}</Badge>
									</div>
									<small>{extension.path}</small>
								</div>
								<div className="skill-card-actions project-resource-actions">
									<Button
										variant="ghost"
										size="icon-sm"
										onClick={() => void toggleExtension(extension)}
										title={extension.enabled !== false ? t("common.disable") : t("common.enabled")}
										style={extension.enabled !== false ? { color: "var(--color-accent)" } : undefined}
									>
										{extension.enabled !== false ? <ToggleRight size={18} strokeWidth={1.8} /> : <ToggleLeft size={18} strokeWidth={1.8} />}
									</Button>
									<Button
										variant="ghost"
										size="icon-sm"
										className="text-destructive hover:bg-destructive/10 hover:text-destructive"
										onClick={() => setDeleteTarget({ kind: "extension", item: extension })}
										disabled={!extension.path}
										title={t("common.delete")}
									>
										<Trash2 size={14} strokeWidth={1.8} />
									</Button>
								</div>
							</article>
						))}
						</div>
					</div>
				) : editingProjectPrompt ? (
					<PromptEditorDialog
						title={`${editingProjectPrompt.name}.md`}
						content={editProjectPromptContent}
						loading={editProjectPromptLoading}
						hint={editProjectPromptSaved ? t("config.promptSavedHint") : undefined}
						onChange={setEditProjectPromptContent}
						onClose={cancelProjectPromptEditor}
					/>
				) : (
					<div className="project-resources-body">
						<Card className="project-skill-create">
							<CardHeader className="gap-1 px-0 py-0">
								<CardTitle className="text-sm">{t("projectResources.createPrompt")}</CardTitle>
								<CardDescription>{t("projectResources.projectScope")}</CardDescription>
							</CardHeader>
							<CardContent className="grid gap-3 px-0 pb-0">
								<Label className="project-resources-name-field grid w-full grid-cols-[4rem_minmax(0,1fr)] items-center gap-2">
									<span>{t("config.name")}</span>
									<Input value={newPromptName} placeholder="my-project-prompt" onChange={(event) => setNewPromptName(event.target.value)} />
								</Label>
								<Label className="project-resources-desc-field grid w-full grid-cols-[4rem_minmax(0,1fr)] items-start gap-2">
									<span className="pt-2">{t("config.description")}</span>
									<Textarea value={newPromptDescription} placeholder="Use when..." onChange={(event) => setNewPromptDescription(event.target.value)} />
								</Label>
								<Button variant="default" onClick={createProjectPrompt} disabled={!canCreatePrompt || creatingPrompt}>
									<MessageSquareText data-icon="inline-start" aria-hidden="true" />
									{creatingPrompt ? t("projectResources.creatingPromptAction") : t("projectResources.createPromptAction")}
								</Button>
							</CardContent>
						</Card>
						<div className="project-resources-list-header">
							<strong>{t("projectResources.promptsTab", { count: prompts.length })}</strong>
							<Badge variant="secondary">{prompts.length}</Badge>
						</div>
						<div className="project-resources-list-section">
						<ResourceListEmpty loading={promptsLoading} empty={prompts.length === 0} label={t("projectResources.emptyPrompts")} />
						{prompts.map((prompt) => (
							<article key={prompt.path} className="project-resource-card">
								{/* 整卡可点击区保留原生 button：内容是 title/desc 排版容器，非图标按钮 */}
								<button
									type="button"
									className="project-resource-info"
									onClick={() => void openProjectPromptEditor(prompt)}
									title={t("common.edit")}
								>
									<div className="project-resource-title">
										<strong>/{prompt.name}</strong>
									</div>
									<small>{prompt.description}</small>
									<small>{prompt.path}</small>
								</button>
								<div className="skill-card-actions project-resource-actions">
									<Button
										variant="ghost"
										size="icon-sm"
										onClick={() => void openProjectPromptEditor(prompt)}
										title={t("common.edit")}
									>
										<Pencil size={14} strokeWidth={1.8} />
									</Button>
									<Button
										variant="ghost"
										size="icon-sm"
										className="text-destructive hover:bg-destructive/10 hover:text-destructive"
										onClick={() => setDeleteTarget({ kind: "prompt", item: prompt })}
										title={t("common.delete")}
									>
										<Trash2 size={14} strokeWidth={1.8} />
									</Button>
								</div>
							</article>
						))}
						</div>
					</div>
				)}
				</ScrollArea>
				</Tabs>
			</DialogContent>
		</Dialog>

			{/* 统一确认删除弹框（#115 U5：换 shadcn ConfirmDialog） */}
			{deleteTarget && (
				<ConfirmDialog
					title={t("common.deleteConfirm")}
					message={deleteTarget.kind === "skill"
						? t("projectResources.deleteSkillConfirm", { name: deleteTarget.item.name })
						: deleteTarget.kind === "extension"
							? t("projectResources.deleteExtensionConfirm", { name: deleteTarget.item.source })
							: t("projectResources.deletePromptConfirm", { name: deleteTarget.item.name })}
					confirmLabel={deleteBusy ? t("common.deleting") : t("common.delete")}
					danger
					onCancel={() => { if (!deleteBusy) setDeleteTarget(null); }}
					onConfirm={() => void confirmDelete()}
				/>
			)}
		</>
	);
}

function ResourceListEmpty(props: { loading: boolean; empty: boolean; label: string }) {
	if (props.loading) return <div className="py-12 text-center text-[13px] text-text-tertiary">{t("common.loading")}</div>;
	if (props.empty) return <div className="py-12 text-center text-[13px] text-text-tertiary">{props.label}</div>;
	return null;
}
