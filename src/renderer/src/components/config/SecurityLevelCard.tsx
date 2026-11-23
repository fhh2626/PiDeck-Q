import { Trash2 } from "lucide-react";
import {
	SECURITY_TOOLS,
	type SecurityAction,
	type SecurityLevelConfig,
	type SecurityPathPolicy,
} from "../../../../shared/types";
import { Button } from "../ui-shadcn/button";
import { Input } from "../ui-shadcn/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui-shadcn/select";
import { Switch } from "../ui-shadcn/switch";
import { Textarea } from "../ui-shadcn/textarea";
import { t } from "../../i18n";

const ACTION_OPTIONS: SecurityAction[] = ["allow", "ask", "deny"];

/** Select only accepts actions in the public security contract. */
function isSecurityAction(value: string): value is SecurityAction {
	return value === "allow" || value === "ask" || value === "deny";
}

/** Keep arbitrary Select values outside the persisted path policy. */
function isSecurityPathPolicy(value: string): value is SecurityPathPolicy {
	return value === "unrestricted" || value === "workspace" || value === "custom";
}

/** 单个等级卡片：折叠态显示摘要，展开态编辑全部字段。 */
export function SecurityLevelCard(props: {
	level: SecurityLevelConfig;
	expanded: boolean;
	onToggle: () => void;
	onChange: (patch: Partial<SecurityLevelConfig>) => void;
	onDelete: () => void;
}) {
	const { level, expanded, onToggle, onChange } = props;
	const toolSummary = SECURITY_TOOLS.map((tool) => {
		const action = level.toolActions[tool] ?? level.defaultAction;
		return `${tool}:${action}`;
	}).join(" · ");

	return (
		<div className="security-level-card rounded-md border border-border/60 bg-card">
			<div className="flex items-center gap-2 px-3 py-2">
				<button
					type="button"
					className="flex min-w-0 flex-1 items-center gap-2 text-left"
					onClick={onToggle}
					aria-expanded={expanded}
				>
					<span className="truncate text-control font-semibold">{level.name}</span>
					{level.builtin && (
						<span className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 text-micro text-muted-foreground">
							{t("security.builtinBadge")}
						</span>
					)}
					{!expanded && (
						<span className="min-w-0 flex-1 truncate text-micro text-muted-foreground">
							{level.description || toolSummary}
						</span>
					)}
				</button>
				{!level.builtin && (
					<Button
						variant="ghost"
						size="icon-sm"
						className="size-6 text-muted-foreground hover:text-danger"
						aria-label={t("common.delete")}
						title={t("common.delete")}
						onClick={props.onDelete}
					>
						<Trash2 size={13} aria-hidden="true" />
					</Button>
				)}
			</div>

			{expanded && (
				<div className="flex flex-col gap-3 border-t border-border/40 px-3 py-3">
					<div className="grid grid-cols-2 gap-3">
						<div className="flex flex-col gap-1">
							<label className="text-micro text-muted-foreground">{t("security.levelName")}</label>
							<Input
								value={level.name}
								onChange={(e) => onChange({ name: e.target.value })}
								disabled={level.builtin}
							/>
						</div>
						<div className="flex flex-col gap-1">
							<label className="text-micro text-muted-foreground">{t("security.levelDescription")}</label>
							<Input
								value={level.description}
								onChange={(e) => onChange({ description: e.target.value })}
							/>
						</div>
					</div>

					{/* 工具动作表 */}
					<div className="flex flex-col gap-1">
						<span className="text-micro text-muted-foreground">{t("security.toolActionsTitle")}</span>
						<div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
							{SECURITY_TOOLS.map((tool) => (
								<div key={tool} className="flex items-center justify-between gap-2">
									<span className="text-control text-muted-foreground">
										{t(`security.tool.${tool}`)}
									</span>
									<Select
										value={level.toolActions[tool] ?? level.defaultAction}
										onValueChange={(value) => {
											if (isSecurityAction(value)) onChange({ toolActions: { ...level.toolActions, [tool]: value } });
										}}
									>
										<SelectTrigger className="h-7 w-24" aria-label={t(`security.tool.${tool}`)}>
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											{ACTION_OPTIONS.map((option) => (
												<SelectItem key={option} value={option}>
													{t(`security.action.${option}`)}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								</div>
							))}
						</div>
						<p className="text-micro text-muted-foreground/80">{t("security.toolActionsHint")}</p>
					</div>

					{/* bash 危险命令 */}
					<div className="flex flex-col gap-1">
						<label className="text-micro text-muted-foreground" htmlFor={`security-bash-patterns-${level.id}`}>{t("security.denyBashTitle")}</label>
						<Textarea
							id={`security-bash-patterns-${level.id}`}
							rows={4}
							className="font-mono text-micro"
							placeholder={t("security.denyBashPlaceholder")}
							value={level.denyBashPatterns.join("\n")}
							onChange={(e) =>
								onChange({
									// Keep blank lines while typing. Saving normalizes the draft.
									denyBashPatterns: e.target.value.split("\n"),
								})
							}
						/>
					</div>

					{/* PowerShell 正则独立作用于 powershell 工具，不与 Bash 规则混用。 */}
					<div className="flex flex-col gap-1">
						<label className="text-micro text-muted-foreground" htmlFor={`security-powershell-patterns-${level.id}`}>{t("security.denyPowerShellTitle")}</label>
						<Textarea
							id={`security-powershell-patterns-${level.id}`}
							rows={4}
							className="font-mono text-micro"
							placeholder={t("security.denyPowerShellPlaceholder")}
							value={(level.denyPowerShellPatterns ?? []).join("\n")}
							onChange={(e) => onChange({ denyPowerShellPatterns: e.target.value.split("\n") })}
						/>
						<p className="text-micro text-muted-foreground/80">{t("security.denyPowerShellHint")}</p>
					</div>

					{/* 目录边界 */}
					<div className="grid grid-cols-2 gap-3">
						<div className="flex flex-col gap-1">
							<label className="text-micro text-muted-foreground">{t("security.pathPolicyTitle")}</label>
							<Select
								value={level.pathPolicy}
								onValueChange={(value) => {
									if (isSecurityPathPolicy(value)) onChange({ pathPolicy: value });
								}}
							>
								<SelectTrigger className="h-8">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="unrestricted">{t("security.pathPolicy.unrestricted")}</SelectItem>
									<SelectItem value="workspace">{t("security.pathPolicy.workspace")}</SelectItem>
									<SelectItem value="custom">{t("security.pathPolicy.custom")}</SelectItem>
								</SelectContent>
							</Select>
						</div>
						<div className="flex flex-col gap-1">
							<label className="text-micro text-muted-foreground">{t("security.defaultActionTitle")}</label>
							<Select
								value={level.defaultAction}
								onValueChange={(value) => {
									if (isSecurityAction(value)) onChange({ defaultAction: value });
								}}
							>
								<SelectTrigger className="h-8">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{ACTION_OPTIONS.map((option) => (
										<SelectItem key={option} value={option}>
											{t(`security.action.${option}`)}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					</div>

					{level.pathPolicy === "custom" && (
						<div className="flex flex-col gap-1">
							<label className="text-micro text-muted-foreground">{t("security.customAllowDirsTitle")}</label>
							<Textarea
								rows={2}
								className="font-mono text-micro"
								placeholder={t("security.dirsPlaceholder")}
								value={level.customAllowDirs.join("\n")}
								onChange={(e) =>
									onChange({
										customAllowDirs: e.target.value
											.split("\n")
											.map((line) => line.trim())
											.filter(Boolean),
									})
								}
							/>
						</div>
					)}

					<div className="flex flex-col gap-1">
						<label className="text-micro text-muted-foreground">{t("security.denyDirsTitle")}</label>
						<Textarea
							rows={2}
							className="font-mono text-micro"
							placeholder={t("security.dirsPlaceholder")}
							value={level.denyDirs.join("\n")}
							onChange={(e) =>
								onChange({
									denyDirs: e.target.value
										.split("\n")
										.map((line) => line.trim())
										.filter(Boolean),
								})
							}
						/>
					</div>

					<div className="flex items-center justify-between gap-3 rounded-sm bg-muted/30 px-3 py-2">
						<span className="text-control text-muted-foreground">{t("security.protectSensitiveTitle")}</span>
						<Switch
							checked={level.protectSensitivePaths}
							onCheckedChange={(checked) => onChange({ protectSensitivePaths: checked })}
						/>
					</div>
				</div>
			)}
		</div>
	);
}
