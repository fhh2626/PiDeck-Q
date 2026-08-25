import { APP_RELEASES_URL } from "../../shared/appIdentity";
import type { PiDesktopApi } from "@shared/desktop/createPiDesktopApi";
import {
	createDefaultExternalEditorSettings,
	createDefaultSecurityConfig,
} from "../../shared/types";
import type {
	AppSettings,
	FileTreeNode,
	Project,
	SessionRecord,
	SessionSummary,
	TerminalDataEvent,
	TerminalExitEvent,
	TerminalTab,
} from "../../shared/types";
import { t } from "./i18n";

const now = Date.now();

const projects: Project[] = [
	{
		id: "builtin-chat",
		name: "Chat",
		path: "C:/Users/14012/AppData/Roaming/pi-desktop/chat-workspace",
		lastOpenedAt: now,
		pinned: true,
		sortOrder: -1,
		kind: "chat",
	},
	{
		id: "preview-project",
		name: "preview-project",
		path: "C:/Users/14012/preview-project",
		lastOpenedAt: now,
		sortOrder: 0,
	},
];

const files: FileTreeNode[] = [
	{
		name: "src",
		path: "C:/Users/14012/preview-project/src",
		relativePath: "src",
		type: "directory",
		children: [
			{
				name: "App.tsx",
				path: "C:/Users/14012/preview-project/src/App.tsx",
				relativePath: "src/App.tsx",
				type: "file",
			},
		],
	},
	{
		name: "README.md",
		path: "C:/Users/14012/preview-project/README.md",
		relativePath: "README.md",
		type: "file",
	},
];

function getSessions(): SessionSummary[] {
	return [
		{
			id: "s1",
			filePath: "preview.jsonl",
			projectPath: projects[0].path,
			name: t("preview.sessionName"),
			preview: t("preview.sessionPreview"),
			updatedAt: now,
			messageCount: 3,
		},
	];
}

const terminalTabs: TerminalTab[] = [];
const terminalDataListeners = new Set<(payload: TerminalDataEvent) => void>();
const terminalExitListeners = new Set<(payload: TerminalExitEvent) => void>();

let previewSettings: AppSettings = {
	useNativeTitleBar: true,
	showNativeMenu: false,
	sendShortcut: "enter-send",
	theme: "system",
	accent: "default",
	themeSkin: "classic-green",
	customThemeOverrides: {},
	backgroundImage: "",
	backgroundImageOpacity: 0.8,
	language: "system",
	startupWindowMode: "last",
	piEnvironmentChecked: true,
	piRuntimePreference: "auto",
	piTypescriptPath: "",
	piRustPath: "",
	sessionTabOpenMode: "preview",
	enableGitManagement: true,
	gitCommitMessagePrompt: "",
	gitCommitMessageProvider: "",
	gitCommitMessageModel: "",
	closeToTray: true,
	singleInstance: true,
	enableNotifications: true,
	// 人文关怀提醒开关：与主进程 SettingsStore 默认值保持一致（预览 mock 需覆盖 AppSettings 全部必填字段）
	agentCountReminderEnabled: true,
	// showThinking 由 pi agent 的 hideThinkingBlock 控制，运行时从主进程加载
	showThinking: true,
	// 流式对话行为：与主进程 SettingsStore 默认一致（预览窗口保持相同观感）
	expandInterimDuringStream: false,
	collapsePrevRunsOnNewTurn: true,
	showDevTools: false,
	piProxyEnabled: false,
	piProxyUrl: "http://127.0.0.1:7890",
	piProxyBypass: "localhost,127.0.0.1,::1",
	desktopProxyEnabled: false,
	desktopProxyUrl: "http://127.0.0.1:7890",
	desktopProxyBypass: "localhost,127.0.0.1,::1",
	customPiPath: "",
	wslEnabled: false,
	wslDistro: "Ubuntu",
	wslUser: "root",
	webServiceEnabled: false,
	webServiceHost: "0.0.0.0",
	webServicePort: 8765,
	rpcTimeout: 600_000,
	workspaceContentOpenMode: "split",
	contentMaxWidth: 1800,
	chatContentWidthPct: 80,
	maxEditorFileSizeMB: 5,
	externalEditors: createDefaultExternalEditorSettings(),

	favoriteModels: [],

	fontSize: "default",
	uiFontSize: null,
	chatFontSize: null,
	inputFontSize: null,
	chatBodyLineHeight: "default",
	chatBlockGap: "default",
	chatListDensity: "default",
	chatCodeDensity: "default",
	zoomFactor: 1,
	fontFamilyBase: "system",
	fontFamilyBaseCustom: "",
	fontFamilyMono: "system-mono",
	fontFamilyMonoCustom: "",
	removedBuiltInExtensions: ["pideck-q-better-compaction.ts"],
	hiddenBuiltinPromptNames: [],
	disableUpdateCheck: false,
	piRpcOffline: true,
	piRpcNoExtensions: false,
	piRpcNoSkills: false,
};

export function createPreviewApi(): PiDesktopApi {
	const noop = (() => () => undefined) as any;
	const clipboardStub: PiDesktopApi["clipboard"] = {
		// preview 模式无真实剪贴板；浏览器下 navigator.clipboard 为异步 API，
		// 与同步接口不匹配，因此返回空串，右键粘贴菜单静默无操作
		readText: () => "",
		readHtml: () => "",
		readImage: () => "",
	};
	const createTerminalTab = async (agentId: string, shell?: string, cwd?: string) => {
		const shellName = shell ?? "powershell";
		const displayName = shellName === "git-bash" ? "Git Bash" : shellName === "bash" ? "bash" : shellName === "cmd" ? "cmd" : "PowerShell";
		const tab: TerminalTab = {
			id: `preview-terminal-${terminalTabs.length + 1}`,
			agentId,
			ownerKey: `agent:${agentId}`,
			title: `${displayName} ${terminalTabs.length + 1}`,
			cwd: "C:/Users/14012/preview-project",
			shell: "powershell",
			createdAt: Date.now(),
		};
		terminalTabs.push(tab);
		setTimeout(() => {
			for (const listener of terminalDataListeners) {
				listener({
					tabId: tab.id,
					data: "Windows PowerShell\r\nPS C:\\\\Users\\\\14012\\\\preview-project> ",
				});
			}
		}, 0);
		return tab;
	};
	return {
		clipboard: clipboardStub,
		// 进程监控预览桩：返回空快照，仅供预览模式不崩溃
		system: {
			getProcessMetrics: async () => ({
				agents: [],
				totalAgentBytes: 0,
				sampledAt: Date.now(),
			}),
			stopAgent: async () => undefined,
		},
		editors: {
			list: async () => [],
			redetect: async () => ({ ...previewSettings }),
			update: async (_editorId, patch) => {
				previewSettings = {
					...previewSettings,
					externalEditors: {
						...previewSettings.externalEditors,
						[_editorId]: {
							...previewSettings.externalEditors[_editorId],
							...patch,
							updatedAt: Date.now(),
						},
					},
				};
				return { ...previewSettings };
			},
			chooseExecutable: async () => null,
			openProject: async () => undefined,
		},
		projects: {
			list: async () => projects,
			add: async () => projects[0],
			remove: async () => projects,
			reorder: async (projectIds) => {
				projects.sort((a, b) => projectIds.indexOf(a.id) - projectIds.indexOf(b.id));
				return projects;
			},
			onChanged: noop,
			listRoot: async () => projects,
			listWorktreeChildren: async () => [],
			toggleWorktreeEnabled: async () => projects[0],
			chooseChatPath: async () => null,
			setChatPath: async () => projects[0],
			listModels: async () => [],
			getModelSpec: async () => null,
			onTrustRequest: noop,
			respondTrustRequest: async () => undefined,
		},
		projectResources: {
			list: async () => ({ skills: [], extensions: [] }),
			createSkill: async (input) => ({
				id: `project-pi:${input.name}`,
				name: input.name,
				description: input.description,
				path: `C:/Users/preview/project/.pi/skills/${input.name}/SKILL.md`,
				dir: `C:/Users/preview/project/.pi/skills/${input.name}`,
				sourceId: "project-pi" as const,
				sourceLabel: ".pi/skills",
				type: "directory" as const,
				enabled: true,
				valid: true,
				warnings: [],
			}),
			deleteSkill: async () => undefined,
			deleteExtension: async () => undefined,
			toggleExtension: async () => undefined,
			renameSkill: async (_projectId, _skillPath, newName) => ({
				id: `project-pi:${newName}`,
				name: newName,
				description: "",
				path: `C:/Users/preview/project/.pi/skills/${newName}/SKILL.md`,
				dir: `C:/Users/preview/project/.pi/skills/${newName}`,
				sourceId: "project-pi" as const,
				sourceLabel: ".pi/skills",
				type: "directory" as const,
				enabled: true,
				valid: true,
				warnings: [],
			}),
		toggleSkill: async (_projectId, _skillPath, enabled) => ({
				id: "project-pi:preview-toggle",
				name: "preview-skill",
				description: "",
				path: "C:/Users/preview/project/.pi/skills/preview-skill/SKILL.md",
				dir: "C:/Users/preview/project/.pi/skills/preview-skill",
				sourceId: "project-pi" as const,
				sourceLabel: ".pi/skills",
				type: "directory" as const,
				enabled,
				valid: true,
				warnings: [],
			}),
		},
		files: {
			list: async () => files,
			open: async () => undefined,
			showInFolder: async () => undefined,
			readContent: async () => "",
			readBase64: async () => "",
			create: async () => "/mock/created",
			writeContent: async () => undefined,
			delete: async () => undefined,
			rename: async () => "",
			copy: async () => [],
			move: async () => [],
			getPathForFile: () => "",
			getClipboardPaths: () => [],
		},
		dialog: {
			pickFiles: async () => [],
			pickBackgroundImage: async () => "",
			removeBackgroundImage: async () => undefined,
		},
		sessions: {
			list: async () => getSessions(),
			listCatalog: async (projectId, _options?: { scan?: boolean }): Promise<SessionRecord[]> => getSessions().map((session) => ({
				id: `preview-record:${session.id}`,
				projectId,
				title: session.name || "Preview session",
				source: session.source || "pi",
				environment: session.wsl ? "wsl" : "native",
				filePath: session.filePath,
				parentSessionPath: session.parentSessionPath,
				projectPath: session.projectPath,
				preview: session.preview,
				messageCount: session.messageCount,
				status: "active",
				createdAt: session.updatedAt,
				updatedAt: session.updatedAt,
				wsl: session.wsl,
			})),
			// 预览模式无后台扫描推送：返回空退订函数满足接口契约
			onCatalogRefreshed: () => () => undefined,
			createDraft: async (input): Promise<SessionRecord> => ({
				id: `preview-draft:${input.projectId}`,
				projectId: input.projectId,
				title: input.title || "New session",
				source: "pi",
				environment: "native",
				preview: "",
				messageCount: 0,
				status: "draft",
				model: input.model,
				thinkingLevel: input.thinkingLevel,
				createdAt: now,
				updatedAt: now,
			}),
			createAnonymous: async (input) => ({
				session: {
					id: `preview-anonymous:${input.projectId}`,
					projectId: input.projectId,
					title: input.title || "Anonymous chat",
					noSession: true,
					source: "pi",
					environment: "native",
					preview: "",
					messageCount: 0,
					status: "active",
					createdAt: now,
					updatedAt: now,
				},
				runtime: {
					sessionId: `preview-anonymous:${input.projectId}`,
					agentId: "preview-anonymous-agent",
					runtimeGeneration: 1,
					projectId: input.projectId,
					cwd: projects.find((project) => project.id === input.projectId)?.path || "",
					status: "idle",
					createdAt: now,
					noSession: true,
				},
			}),
			updateRecord: async (sessionId, patch): Promise<SessionRecord> => ({
				id: sessionId,
				projectId: projects[0].id,
				title: patch.title || "Preview session",
				source: "pi",
				environment: "native",
				preview: "",
				messageCount: 0,
				status: "draft",
				model: patch.model,
				thinkingLevel: patch.thinkingLevel,
				createdAt: now,
				updatedAt: now,
			}),
			deleteRecord: async () => true,
			archiveRecord: async () => true,
			unarchiveRecord: async () => true,
			listArchived: async () => [],
			copyRecord: async (sessionId) => ({
				cancelled: false,
				targetSessionId: `${sessionId}:copy`,
			}),
			exportRecordHtml: async () => ({ path: "preview-session.html" }),
			readRecordMessages: async () => [],
			readProcessEvents: async () => [],
						readRecordMessagePage: async () => ({ messages: [], total: 0, nextBefore: null }),
			readMessageFullText: async () => ({ text: "" }),
			readReferenceMessages: async () => [
				{ role: "user", content: "Preview user message", timestamp: Date.now() - 60000 },
				{ role: "assistant", content: "Preview assistant response", timestamp: Date.now() - 30000 },
			],
			getContextControllerState: async () => ({
				clearToolHistory: false,
				clearReadContent: false,
				clearCommandContent: false,
				keepRecentCount: 10,
			}),
			sendPrompt: async (input) => ({
				accepted: true,
				sessionId: input.sessionId,
				requestId: input.requestId,
				agentId: "preview-agent",
				sessionPath: "C:/Users/preview/.pi/session.jsonl",
				runtimeGeneration: 1,
			}),
			sendUiResponse: async () => undefined,
			onRuntimeEvent: noop,
			listRuntimes: async () => [],
			activateRuntime: async () => ({
				ok: false,
				error: { code: "SESSION_NOT_FOUND", debugDetails: "preview runtime activation is disabled" },
			}),
			stopRuntime: async (target) => ({ ok: true, value: target }),
			abortRuntime: async (target) => ({
				ok: true,
				value: { target, value: undefined },
			}),
			restartRuntime: async (target) => ({
				ok: true,
				value: {
					previousTarget: target,
					runtime: {
						...target,
						projectId: projects[0].id,
						cwd: projects[0].path,
						status: "idle" as const,
						createdAt: now,
					},
					session: {
						id: target.sessionId,
						projectId: projects[0].id,
						title: "Preview session",
						source: "pi" as const,
						environment: "native" as const,
						preview: "",
						messageCount: 0,
						status: "active" as const,
						createdAt: now,
						updatedAt: now,
					},
				},
			}),
			compactRuntime: async (target) => ({
				ok: true,
				value: { target, value: {} },
			}),
			getRuntimeForkMessages: async (target) => ({
				ok: true,
				value: { target, value: [] },
			}),
			forkRuntimeSession: async (target) => ({
				ok: true,
				value: { cancelled: false, text: "", targetSessionId: `${target.sessionId}:fork` },
			}),
			setFocusedSession: async () => undefined,
			getRuntimeState: async (target) => ({
				ok: true,
				value: { target, value: {} },
			}),
			listRuntimeCommands: async (target) => ({
				ok: true,
				value: { target, value: [] },
			}),
			listRuntimeModels: async (target) => ({
				ok: true,
				value: { target, value: [] },
			}),
			exportRuntimeHtml: async (target) => ({
				ok: true,
				value: { target, value: { path: "preview-session.html" } },
			}),
			editRuntimeMessage: async (target) => ({
				ok: true,
				value: { target, value: undefined },
			}),
			deleteRuntimeMessage: async (target) => ({
				ok: true,
				value: { target, value: undefined },
			}),
			prepareRuntimeResend: async (target) => ({
				ok: true,
				value: { target, value: { text: "" } },
			}),
			setRuntimeModel: async (target) => ({
				ok: true,
				value: { target, value: {} },
			}),
			setRuntimeThinking: async (target) => ({
				ok: true,
				value: { target, value: {} },
			}),
			cloneRuntime: async (target) => ({
				ok: true,
				value: { targetSessionId: `${target.sessionId}:copy` },
			}),
		},
		usageStats: {
			detect: async () => ({
				installed: false,
				logPath: null,
				recordCount: null,
				firstRecordAt: null,
				lastRecordAt: null,
			}),
			refresh: async () => ({
				fullRescan: false,
				parsedRecords: 0,
				skippedLines: 0,
			}),
			get: async () => null as unknown as import("../../shared/types").UsageAggregated,
		},
		codexSessions: {
			scan: async () => [],
			import: async () => ({ results: [], imported: 0, failed: 0 }),
		},
		claudeSessions: {
			scan: async () => [],
			import: async () => ({ results: [], imported: 0, failed: 0 }),
		},
		openCodeSessions: {
			scan: async () => [],
			import: async () => ({ results: [], imported: 0, failed: 0 }),
		},
		git: {
			branches: async () => ({ current: "main", branches: ["main", "dev"] }),
			checkout: async (_projectId, branch) => ({
				current: branch,
				branches: ["main", "dev"],
			}),
			createBranch: async (_projectId, branchName) => ({
				current: branchName,
				branches: ["main", "dev", branchName],
			}),
			// 预览环境无真实 Git，返回空原始内容，差异左侧显示为空。
			originalContent: async () => "",
			worktreeList: async () => [],
			worktreeCreate: async (_projectId, branchName) => ({
				path: `/tmp/worktree/${branchName}`,
				branch: branchName,
			}),
			worktreeRemove: async () => true,
				commitLog: async () => [],
				refs: async () => [],
				branchCompare: async () => ({ files: [], ahead: 0, behind: 0 }),
				commitDetail: async () => null,
				commitFileDiff: async () => null,
				diffFileBetween: async () => "",
				status: async () => ({ merge: [], index: [], workingTree: [], untracked: [] }),
				workspaceFileDiff: async () => null,
				stage: async () => {},
				unstage: async () => {},
				discard: async () => {},
				commit: async () => {},
				cherryPick: async () => {},
				revert: async () => {},
				reset: async () => {},
				dropCommit: async () => {},
				generateCommitMessage: async () => ({ ok: true, message: "" }),
				init: async () => {},
			pull: async () => {},
			push: async () => {},
			fetch: async () => undefined,
			// 预览环境无真实远程：恒返回 null（不显示 push/pull 角标）
			aheadBehind: async () => null,
			deleteFiles: async () => {},
		},
		logs: {
			list: async () => [],
			listPage: async () => ({ entries: [], total: 0, page: 0, pageSize: 50, hasMore: false }),
			clear: async () => undefined,
			openFolder: async () => undefined,
			getSize: async () => 0,
		},
		rpcLogs: {
			getSize: async () => 0,
			get: async () => [],
			getLive: async () => [],
			save: async () => [],
			onLog: (_callback: unknown) => () => {},
			clear: async () => undefined,
			setLogging: async () => false,
			getLogging: async () => false,
		},
		pi: {
			check: async () => ({
				installed: true,
				command: "pi",
				version: "preview",
				searchedDirs: [],
			}),
			checkCustom: async (_path) => ({
				installed: true,
				command: _path,
				version: "preview",
				searchedDirs: [],
			}),
			checkUpdate: async () => ({
				currentVersion: "preview",
				latestVersion: "preview",
				hasUpdate: false,
			}),
			update: async () => ({
				command: "pi update pi --no-approve",
				output: "Preview mode: pi update output",
				updated: false,
			}),
			execInstall: async (_command) => ({
				success: true,
				exitCode: 0,
				stdout: "preview: exec install output",
				stderr: "",
			}),
			checkNpm: async () => ({
				available: true,
				version: "preview",
			}),
		},
		wsl: {
			listDistros: async () => ["Ubuntu", "Debian"],
			validateConnection: async (_distro, _user) => ({
				ok: true,
				whoami: "preview",
				piVersion: "preview",
				error: "",
			}),
		},
		app: {
			info: async () => ({
				version: "preview",
				releasesUrl: APP_RELEASES_URL,
				platform: "win32" as NodeJS.Platform,
				homeDir: "C:/Users/preview",
			}),
			preferredSystemLanguages: async () => navigator.languages?.length ? [...navigator.languages] : [navigator.language],
			networkAddresses: async () => [{ address: "192.168.1.100", interfaceName: "Wi-Fi", cidr: "192.168.1.100/24", isPrivate: true }],
			checkUpdate: async () => ({
				currentVersion: "preview",
				latestVersion: "preview",
				hasUpdate: false,
				releaseName: "preview",
				releaseNotes: "",
				releaseUrl: APP_RELEASES_URL,
				assets: [],
			}),
			downloadUpdate: async (asset) => ({
				filePath: asset.name,
				assetName: asset.name,
			}),
			installUpdate: async () => undefined,
			onUpdateProgress: () => () => undefined,
			onFocusSessionTarget: () => () => undefined,
			getPendingFocusTarget: async () => null,
			ackFocusSessionTarget: async () => undefined,
			openExternal: async () => undefined,
			restart: async () => undefined,
			rendererLog: async (level, scope, message, detail) => {
				console[level === "error" ? "error" : level === "warn" ? "warn" : "debug"](
					`[${scope}] ${message}`,
					detail,
				);
			},
			minimizeWindow: async () => undefined,
			toggleMaximizeWindow: async () => false,
			isWindowMaximized: async () => false,
			onWindowMaximizedChange: () => () => undefined,
			toggleAlwaysOnTopWindow: async () => false,
			closeWindow: async () => undefined,
			beginWindowDrag: async () => undefined,
			toggleDevTools: async () => false,
		},
		skills: {
			list: async () => ({
				locations: [
					{
						id: "pi-global" as const,
						label: "~/.pi/agent/skills",
						path: "C:/Users/preview/.pi/agent/skills",
						rootMarkdownEnabled: true,
					},
				],
				skills: [],
			}),
			create: async (input) => ({
				id: `pi-global:${input.name}`,
				name: input.name,
				description: input.description,
				path: `C:/Users/preview/.pi/agent/skills/${input.name}/SKILL.md`,
				dir: `C:/Users/preview/.pi/agent/skills/${input.name}`,
				sourceId: input.locationId,
				sourceLabel: "~/.pi/agent/skills",
				type: "directory" as const,
				enabled: true,
				valid: true,
				warnings: [],
			}),
			toggle: async (path, enabled) => ({
				id: `pi-global:${path}`,
				name: "preview-skill",
				description: "Preview skill",
				path,
				dir: path.replace(/[/\\]SKILL\.md$/, ""),
				sourceId: "pi-global" as const,
				sourceLabel: "~/.pi/agent/skills",
				type: "directory" as const,
				enabled,
				valid: true,
				warnings: [],
			}),
			delete: async () => undefined,
			openFolder: async () => undefined,
			rename: async (_skillPath, newName) => ({
				id: `pi-global:preview/${newName}/SKILL.md`,
				name: newName,
				description: "Preview skill",
				path: `C:/Users/preview/.pi/agent/skills/${newName}/SKILL.md`,
				dir: `C:/Users/preview/.pi/agent/skills/${newName}`,
				sourceId: "pi-global" as const,
				sourceLabel: "~/.pi/agent/skills",
				type: "directory" as const,
				enabled: true,
				valid: true,
				warnings: [],
			}),
		},
		extensions: {
			list: async (_forceRefresh = false) => ({
				extensions: [
					{
						id: "user:npm:preview-extension",
						source: "npm:preview-extension",
						path: "C:/Users/preview/.pi/agent/npm/node_modules/preview-extension",
						scope: "user" as const,
						enabled: true,
					},
				],
				raw: "User packages:\n  npm:preview-extension\n    C:/Users/preview/.pi/agent/npm/node_modules/preview-extension\n",
			}),
			uninstall: async () => undefined,
			install: async (_source: string) => "",
			toggle: async () => undefined,
			removeBuiltIn: async () => undefined,
			restoreBuiltIn: async () => undefined,
			update: async () => ({
				command: "pi update --extensions --no-approve",
				output: "Preview mode: extensions update output",
				updated: false,
			}),
			updateOne: async (_source: string) => ({
				command: "pi update <source>",
				output: "Preview mode: extension update-one output",
				updated: false,
			}),
		},
		prompts: {
			list: async () => ({ templates: [], globalDir: "C:/Users/preview/.pi/agent/prompts", hasHiddenBuiltins: false }),
			create: async (input) => ({
				name: input.name,
				path: `C:/Users/preview/.pi/agent/prompts/${input.name}.md`,
				description: input.description,
				content: `---\ndescription: ${input.description}\n---\n`,
				userCreated: true,
			}),
			delete: async () => undefined,
			openFolder: async () => undefined,
			restoreBuiltins: async () => undefined,
			edit: async (_filePath, _content?) => "---\ndescription: Preview\n---\n\nPreview content",
			listByProject: async () => ({ templates: [], globalDir: "", hasHiddenBuiltins: false }),
			createInProject: async (_projectPath, input) => ({
				name: input.name,
				path: `project://${_projectPath}/.pi/prompts/${input.name}.md`,
				description: input.description,
				content: `---\ndescription: ${input.description}\n---\n`,
				userCreated: true,
				scope: "project",
			}),
			deleteFromProject: async () => undefined,
			rename: async (_oldName, newName) => ({
				name: newName,
				path: `C:/Users/preview/.pi/agent/prompts/${newName}.md`,
				description: "Renamed prompt",
				content: `---\ndescription: Renamed prompt\n---\n`,
				userCreated: true,
			}),
			renameInProject: async (_projectPath, _oldName, newName) => ({
				name: newName,
				path: `project://${_projectPath}/.pi/prompts/${newName}.md`,
				description: "Renamed project prompt",
				content: `---\ndescription: Renamed project prompt\n---\n`,
				userCreated: true,
				scope: "project",
			}),
		},
		promptStore: {
			search: async (_query, _opts) => ({ query: _query ?? "", count: 0, prompts: [] }),
			get: async (_id) => ({ id: _id, title: "", description: "", content: "", type: "TEXT", author: "", category: "", tags: [], votes: 0, createdAt: "" }),
			import: async (data) => ({
				name: data.title.toLowerCase().replace(/[^\w-]+/g, "-"),
				path: `C:/Users/preview/.pi/agent/prompts/${data.title.toLowerCase().replace(/[^\w-]+/g, "-")}.md`,
				description: data.description,
				content: data.content,
				userCreated: true,
			}),
		},
		yaoPrompts: {
			list: async () => ({ categories: [], prompts: [], repoPath: "" }),
			detail: async () => ({ title: "", description: "", promptContent: "", fullContent: "" }),
			import: async (_slug, _category) => ({
				name: _slug,
				path: `C:/Users/preview/.pi/agent/prompts/${_slug}.md`,
				description: "Preview import",
				content: "Preview content",
				userCreated: true,
			}),
		},
		skillStore: {
			search: async () => ({ query: "", count: 0, prompts: [] }),
			import: async (data, _locationId) => ({
				name: data.title.toLowerCase().replace(/[^\w-]+/g, "-"),
				path: `C:/Users/preview/.pi/agent/skills/${data.title.toLowerCase().replace(/[^\w-]+/g, "-")}/SKILL.md`,
				description: data.description,
				enabled: true,
				valid: true,
				warnings: [],
				id: `pi-global:preview`,
				dir: "",
				sourceId: "pi-global",
				sourceLabel: "Preview",
				type: "directory",
			}),
		},
		skillHub: {
			search: async () => ({ query: "", total: 0, items: [] }),
			detail: async () => null,
			install: async (slug) => ({ success: true, slug, installDir: "", message: "Preview install" }),
		},
		settings: {
			get: async (): Promise<AppSettings> => ({ ...previewSettings }),
			update: async (patch): Promise<AppSettings> => {
				previewSettings = { ...previewSettings, ...patch };
				return { ...previewSettings };
			},
			restartWebService: async () => undefined,
			testPiProxy: async () => ({
				success: true,
				url: "https://api.openai.com/v1/models",
				elapsedMs: 120,
				statusCode: 401,
				message: t("preview.proxyOk"),
			}),
			onApplyWindow: noop,
		},
		security: {
			getConfig: async () => createDefaultSecurityConfig(),
			updateConfig: async () => ({
				ok: true,
				config: createDefaultSecurityConfig(),
			}),
			setSessionLevel: async () => ({
				ok: true,
				config: createDefaultSecurityConfig(),
			}),
		},
		config: {
			getModels: async () => ({
				raw: '{"providers":{}}',
				parsed: { providers: {} },
			}),
			getAuth: async () => ({ raw: "{}", parsed: {} }),
			getSettings: async () => ({ raw: "{}", parsed: {} }),
			getTrust: async () => ({ raw: "{}", parsed: {} }),
			saveModels: async () => ({ valid: true }),
			saveAuth: async () => ({ valid: true }),
			saveSettings: async () => ({ valid: true }),
			saveRaw: async () => ({ valid: true }),
			export: async () =>
				JSON.stringify({
					version: 1,
					exportedAt: new Date().toISOString(),
					files: { "models.json": {}, "auth.json": {}, "settings.json": {} },
				}),
			import: async () => ({ valid: true }),
			fetchModels: async () => ({
				success: true,
				models: [
					{ id: "gpt-4o", name: "GPT-4o" },
					{ id: "gpt-4o-mini", name: "GPT-4o Mini" },
				],
			}),
			testProvider: async () => ({
				success: true,
				model: "gpt-4o-mini",
				snippet: "Hello! How can I help you today?",
				tokens: { input: 8, output: 7 },
				latencyMs: 320,
				requestUrl: "https://api.openai.com/v1/chat/completions",
				requestBody: '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"Hi"}],"max_tokens":10}',
			}),
			visionGetConfig: async () => ({
				config: null,
				configDir: "/tmp/preview/.pi/agent",
			}),
			visionSaveConfig: async () => ({ ok: true }),
			visionGetLog: async () => ({ exists: false, size: 0, content: "", truncated: false }),
			visionClearLog: async () => ({ ok: true }),
			visionGetEvents: async () => ({ exists: false, size: 0, events: [], truncated: false }),
			visionClearEvents: async () => ({ ok: true }),
		},
		terminal: {
			// 预览模式只按归属键过滤：agent 目标用 agentId，project 目标用项目 id
			list: async (target) =>
				terminalTabs.filter((tab) => tab.agentId === (target.kind === "agent" ? target.agentId : target.projectId)),
			ensure: async (target) => {
				const key = target.kind === "agent" ? target.agentId : target.projectId;
				const existing = terminalTabs.filter((tab) => tab.agentId === key);
				if (existing.length > 0) return existing;
				return [await createTerminalTab(key)];
			},
			create: (target) => createTerminalTab(target.kind === "agent" ? target.agentId : target.projectId),
			input: async (tabId, data) => {
				for (const listener of terminalDataListeners) {
					listener({ tabId, data });
				}
			},
			resize: async () => undefined,
			close: async (tabId) => {
				const index = terminalTabs.findIndex((tab) => tab.id === tabId);
				if (index >= 0) terminalTabs.splice(index, 1);
			},
			onData: (callback) => {
				terminalDataListeners.add(callback);
				return () => {
					terminalDataListeners.delete(callback);
				};
			},
			onExit: (callback) => {
				terminalExitListeners.add(callback);
				return () => {
					terminalExitListeners.delete(callback);
				};
			},
			shells: async () => [
				{ shell: "powershell", label: "PowerShell", available: true },
				{ shell: "pwsh", label: "pwsh", available: true },
				{ shell: "cmd", label: "cmd", available: true },
			],
		},
		scratchPad: {
			list: async () => [],
			create: async () => ({ id: "", name: "", path: "", createdAt: 0, updatedAt: 0 }),
			delete: async () => {},
			load: async () => ({ content: "", lastEditedAt: 0, cursorPosition: 0 }),
			save: async () => {},
			export: async () => false,
		},


	};
}
