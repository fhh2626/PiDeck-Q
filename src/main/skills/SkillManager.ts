import { existsSync, type Dirent } from "node:fs";
import {
	mkdir,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { TrashPath } from "../fs/trash";
import type {
	CreatePiSkillInput,
	PiSkillListResult,
	PiSkillLocation,
	PiSkillSummary,
} from "../../shared/types";
import type { WslEnvironment } from "../wsl/WslPaths";
import type { MainProcessTranslationKey } from "../../shared/i18n/mainProcessCopy";

const SKILL_FILE = "SKILL.md";

type SkillCopy = (
	key: MainProcessTranslationKey,
	params?: Record<string, string | number>,
) => string;

export type SkillPlatformOps = {
	openPath?: (path: string) => Promise<{ ok: boolean; error?: string }>;
	trashPath?: TrashPath;
};

/**
 * 管理 pi 全局 Skill 目录。
 * 第一版仅操作全局目录，不触碰项目级 .pi/.agents skills，避免误删项目资产或绕过 trusted project 规则。
 */
export class SkillManager {
	private locations: PiSkillLocation[];
	/**
	 * 构造时注入的本地基准 home。
	 * configureWsl(null) 恢复的是该值，而不是重新读取 os.homedir()。
	 */
	private readonly localHome: string;

	constructor(
		home?: string,
		private readonly translate: SkillCopy = () => "Skill operation failed.",
		private readonly platformOps?: SkillPlatformOps,
	) {
		this.localHome = home ?? homedir();
		this.locations = this.buildLocations(this.localHome);
	}

	/** 将 skill 目录切换到统一解析出的 WSL HOME；null 恢复构造时注入的本地 home。 */
	configureWsl(environment: WslEnvironment | null) {
		this.locations = this.buildLocations(environment?.windowsHome ?? this.localHome);
	}

	private buildLocations(home: string): PiSkillLocation[] {
		return [
			{
				id: "pi-global",
				label: "~/.pi/agent/skills",
				path: join(home, ".pi", "agent", "skills"),
				rootMarkdownEnabled: true,
			},
			{
				id: "agents-global",
				label: "~/.agents/skills",
				path: join(home, ".agents", "skills"),
				rootMarkdownEnabled: false,
			},
		];
	}

	async list(): Promise<PiSkillListResult> {
		const skills = (
			await Promise.all(this.locations.map((location) => this.scanLocation(location)))
		).flat();
		// 按 name 去重，优先保留 pi-global 目录下的条目
		// （避免 ~/.pi/agent/skills/ 和 ~/.agents/skills/ 不同步导致同名重复）
		const seen = new Map<string, PiSkillSummary>();
		for (const skill of skills) {
			const key = skill.name.toLowerCase();
			if (!seen.has(key) || (seen.get(key)!.sourceId !== "pi-global" && skill.sourceId === "pi-global")) {
				seen.set(key, skill);
			}
		}
		return { locations: this.locations, skills: Array.from(seen.values()) };
	}

	/** 返回当前全局 skill 根目录，供主进程文件 IPC 做边界校验。 */
	getDirs(): string[] {
		return this.locations.map((location) => location.path);
	}

	async create(input: CreatePiSkillInput): Promise<PiSkillSummary> {
		const location = this.requireLocation(input.locationId);
		const name = this.normalizeSkillName(input.name);
		const description = input.description.trim();
		if (!name) throw new Error(this.translate("mainSkill.nameRequiredDetailed"));
		if (!description) throw new Error(this.translate("mainSkill.descriptionRequired"));

		const skillDir = join(location.path, name);
		if (existsSync(skillDir)) throw new Error(this.translate("mainSkill.alreadyExists", { name }));
		await mkdir(skillDir, { recursive: true });
		const skillPath = join(skillDir, SKILL_FILE);
		await writeFile(
			skillPath,
			`---\nname: ${name}\ndescription: ${description.replace(/\n/g, " ")}\n---\n\n# ${name}\n\n## Usage\n\nDescribe when and how to use this skill.\n`,
			"utf8",
		);
		return this.readSkill(skillPath, location, "directory");
	}

	async toggle(skillPath: string, enabled: boolean): Promise<PiSkillSummary> {
		const skill = await this.findByPath(skillPath);
		const raw = await readFile(skill.path, "utf8");
		const next = this.setFrontmatterBoolean(raw, "disable-model-invocation", !enabled);
		await writeFile(skill.path, next, "utf8");
		return this.findByPath(skill.path);
	}

	async delete(skillPath: string): Promise<void> {
		const skill = await this.findByPath(skillPath);
		if (!this.platformOps?.trashPath) {
			throw new Error("Trash service unavailable");
		}
		// 目录型 skill 删除整个目录；根 markdown skill 仅删除单个 md 文件。
		// 用户 skill 是内容资产：走系统回收站（可恢复）并记审计日志，拒绝 rm 硬删。
		await this.platformOps.trashPath(skill.type === "directory" ? skill.dir : skill.path, { source: "skills:delete" });
	}

	async openFolder(skillPath?: string): Promise<void> {
		if (!skillPath) {
			await mkdir(this.locations[0].path, { recursive: true });
			if (this.platformOps?.openPath) {
				await this.platformOps.openPath(this.locations[0].path);
			}
			return;
		}
		const skill = await this.findByPath(skillPath);
		if (this.platformOps?.openPath) {
			await this.platformOps.openPath(skill.dir);
		}
	}

	private async scanLocation(location: PiSkillLocation): Promise<PiSkillSummary[]> {
		await mkdir(location.path, { recursive: true });
		const entries = await readdir(location.path, { withFileTypes: true }).catch(() => []);
		const skills: PiSkillSummary[] = [];
		const ancestors = new Set<string>();
		const canonicalLocation = await realpath(location.path).catch(() => null);
		if (canonicalLocation) ancestors.add(canonicalLocation);
		for (const entry of entries) {
			const fullPath = join(location.path, entry.name);
			const kind = await this.getEntryKind(fullPath, entry);
			if (kind === "directory") {
				await this.collectDirectorySkills(fullPath, location, skills, ancestors);
			} else if (location.rootMarkdownEnabled && kind === "file" && entry.name.toLowerCase().endsWith(".md")) {
				skills.push(await this.readSkill(fullPath, location, "markdown"));
			}
		}
		return skills.sort((a, b) => a.name.localeCompare(b.name));
	}

	private async getEntryKind(
		fullPath: string,
		entry: Dirent,
	): Promise<"directory" | "file" | "other"> {
		if (entry.isDirectory()) return "directory";
		if (entry.isFile()) return "file";
		if (!entry.isSymbolicLink()) return "other";

		const target = await stat(fullPath).catch(() => null);
		if (!target) return "other";
		if (target.isDirectory()) return "directory";
		if (target.isFile()) return "file";
		return "other";
	}

	private async collectDirectorySkills(
		dir: string,
		location: PiSkillLocation,
		out: PiSkillSummary[],
		ancestors = new Set<string>(),
	) {
		const canonicalDir = await realpath(dir).catch(() => null);
		if (!canonicalDir || ancestors.has(canonicalDir)) return;

		// 只记录当前递归链，避免软连接环路；不同入口仍保留各自的 Skill 路径。
		const nextAncestors = new Set(ancestors);
		nextAncestors.add(canonicalDir);

		const skillPath = join(dir, SKILL_FILE);
		if (existsSync(skillPath)) {
			out.push(await this.readSkill(skillPath, location, "directory"));
			return;
		}
		const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
		for (const entry of entries) {
			const fullPath = join(dir, entry.name);
			if ((await this.getEntryKind(fullPath, entry)) === "directory") {
				await this.collectDirectorySkills(fullPath, location, out, nextAncestors);
			}
		}
	}

	private async readSkill(
		skillPath: string,
		location: PiSkillLocation,
		type: PiSkillSummary["type"],
	): Promise<PiSkillSummary> {
		const raw = await readFile(skillPath, "utf8").catch(() => "");
		const frontmatter = this.parseFrontmatter(raw);
		const name = String(frontmatter.name ?? "").trim();
		const description = String(frontmatter.description ?? "").trim();
		const warnings = this.validateSkill(name, description);
		return {
			id: `${location.id}:${skillPath}`,
			name: name || dirname(skillPath).split(/[\\/]/).pop() || this.translate("mainSkill.unnamed"),
			description,
			path: skillPath,
			dir: type === "directory" ? dirname(skillPath) : dirname(skillPath),
			sourceId: location.id,
			sourceLabel: location.label,
			type,
			enabled: frontmatter["disable-model-invocation"] !== "true",
			valid: warnings.length === 0,
			warnings,
		};
	}

	private parseFrontmatter(raw: string) {
		const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
		const result: Record<string, string> = {};
		if (!match) return result;
		for (const line of match[1].split(/\r?\n/)) {
			const index = line.indexOf(":");
			if (index === -1) continue;
			const key = line.slice(0, index).trim();
			let value = line.slice(index + 1).trim();
			value = value.replace(/^['\"]|['\"]$/g, "");
			if (key) result[key] = value;
		}
		return result;
	}

	private setFrontmatterBoolean(raw: string, key: string, value: boolean) {
		const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
		if (!match) return `---\n${key}: ${value}\n---\n\n${raw}`;
		const lines = match[1].split(/\r?\n/);
		let changed = false;
		const nextLines = lines.map((line) => {
			if (!line.trim().startsWith(`${key}:`)) return line;
			changed = true;
			return `${key}: ${value}`;
		});
		if (!changed) nextLines.push(`${key}: ${value}`);
		return raw.replace(match[0], `---\n${nextLines.join("\n")}\n---`);
	}

	private validateSkill(name: string, description: string) {
		const warnings: string[] = [];
		if (!name) warnings.push(this.translate("mainSkill.warningNameRequired"));
		if (name && !/^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u.test(name)) {
			warnings.push(this.translate("mainSkill.warningNameCharacters"));
		}
		if (name.length > 64) warnings.push(this.translate("mainSkill.warningNameTooLong"));
		if (!description) warnings.push(this.translate("mainSkill.warningDescriptionRequired"));
		if (description.length > 1024) warnings.push(this.translate("mainSkill.warningDescriptionTooLong"));
		return warnings;
	}

	/** 重命名 Skill：重命名目录并更新 SKILL.md 中的 name 字段 */
	async rename(skillPath: string, newName: string): Promise<PiSkillSummary> {
		const skill = await this.findByPath(skillPath);
		const normalizedNew = this.normalizeSkillName(newName);
		if (!normalizedNew) throw new Error(this.translate("mainSkill.nameRequired"));

		const displayName = newName.trim();
		const oldDir = skill.dir;
		const parentDir = skill.dir.split(/[\\/]/).slice(0, -1).join("\\");
		const newDir = join(parentDir, normalizedNew);

		if (oldDir === newDir) throw new Error(this.translate("mainSkill.sameName"));
		if (existsSync(newDir)) throw new Error(this.translate("mainSkill.alreadyExists", { name: normalizedNew }));

		// 更新 SKILL.md 中的 name frontmatter
		const raw = await readFile(skill.path, "utf8");
		const updated = this.setFrontmatterName(raw, displayName);
		await writeFile(skill.path, updated, "utf8");

		await rename(oldDir, newDir);

		// 重命名后路径变为新路径
		const newSkillPath = join(newDir, skill.path.split(/[\\/]/).pop()!);
		// 找对应的 location（搜索所有 locations）
		const { skills } = await this.list();
		const reloaded = await this.readSkill(
			newSkillPath,
			this.locations.find((l) => newSkillPath.startsWith(l.path)) ?? this.locations[0],
			skill.type,
		);
		return reloaded;
	}

	/** 更新 frontmatter 中的 name 字段 */
	private setFrontmatterName(raw: string, name: string): string {
		const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
		if (!match) return `---\nname: ${name}\n---\n\n${raw}`;
		const lines = match[1].split(/\r?\n/);
		const nextLines = lines.map((line) => {
			if (line.trim().startsWith("name:")) return `name: ${name}`;
			return line;
		});
		return raw.replace(match[0], `---\n${nextLines.join("\n")}\n---`);
	}

	/** 规范化 Skill 名称：保留 Unicode 字母（含中文等）、数字和连字符 */
	private normalizeSkillName(value: string) {
		return value.trim().toLowerCase().replace(/[^\p{L}\p{N}-]+/gu, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
	}

	private requireLocation(id: PiSkillLocation["id"]) {
		const location = this.locations.find((item) => item.id === id);
		if (!location) throw new Error(this.translate("mainSkill.unknownLocation", { id }));
		return location;
	}

	private async findByPath(skillPath: string) {
		const { skills } = await this.list();
		const skill = skills.find((item) => item.path === skillPath);
		if (!skill) throw new Error(this.translate("mainSkill.notFound"));
		return skill;
	}
}
