import { useEffect, useRef, useState } from "react";
import type { MouseEvent } from "react";
import { Check, Eye, EyeOff, ChevronDown } from "lucide-react";
import { t } from "../i18n";
import { writeClipboard } from "../utils/clipboard";
import { PROVIDER_API_OPTIONS, API_TYPE_LABELS, getApiTypeDescription } from "./providerHeaders";
import { Button } from "../components/ui-shadcn/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui-shadcn/select";
import { Input } from "../components/ui-shadcn/input";

// ── 复制到剪贴板工具 ──────────────────────────────────

/**
 * 外部文档/服务页面通过 desktopApi.app.openExternal 交由系统默认浏览器打开；
 * 保留 href 语义供中键/辅助功能使用。
 */
export function openDocsInSystemBrowser(url: string) {
	return (event: MouseEvent) => {
		event.preventDefault();
		void window.piDesktop.app.openExternal(url, true);
	};
}

export function CopyButton(props: { text: string }) {
	const [copied, setCopied] = useState(false);
	const handleCopy = async (e: MouseEvent) => {
		e.stopPropagation();
		await writeClipboard(props.text);
		setCopied(true);
		setTimeout(() => setCopied(false), 1500);
	};
	return (
		<button
			className={`config-copy-btn ${copied ? "copied" : ""}`}
			onClick={handleCopy}
			title={t("common.copy")}
		>
			{copied ? (
				<>
					<Check size={14} /> {t("terminal.copied")}
				</>
			) : (
				t("common.copy")
			)}
		</button>
	);
}

/** 密码输入框：支持显示/隐藏 + 复制 */
export function SecretInput(props: {
	value: string;
	onChange: (v: string) => void;
	placeholder?: string;
}) {
	const [visible, setVisible] = useState(false);
	return (
		<div className="flex w-full items-center gap-1.5">
			<Input
				type={visible ? "text" : "password"}
				value={props.value}
				onChange={(e) => props.onChange(e.target.value)}
				placeholder={props.placeholder ?? t("config.apiKeyPlaceholder")}
				className="h-8 min-w-0 flex-1 rounded-sm border border-border-subtle bg-bg-panel px-3 font-mono text-control text-text-primary outline-none transition-[border-color,box-shadow,background-color] duration-150 focus:border-[var(--color-accent)] focus:shadow-[var(--focus-ring)]"
			/>
			<Button
				variant="outline"
				size="icon-sm"
				className="size-9 rounded-sm"
				onClick={() => setVisible(!visible)}
				title={visible ? t("common.hide") : t("common.show")}
			>
				{visible ? <EyeOff size={15} /> : <Eye size={15} />}
			</Button>
			<CopyButton text={props.value} />
		</div>
	);
}

// ── Models Tab ──────────────────────────────────────────

/** Radix Select 不允许空字符串 value，用哨兵值映射回 ""。 */
const SENTINEL = "__none__";

export function ConfigSelect(props: {
	value: string;
	options: Array<{ value: string; label: string }>;
	onChange: (value: string) => void;
	placeholder?: string;
}) {
	return (
		<Select
			value={props.value === "" ? SENTINEL : props.value}
			onValueChange={(value) => props.onChange(value === SENTINEL ? "" : value)}
		>
			<SelectTrigger className="config-select-trigger">
				<SelectValue placeholder={props.placeholder ?? props.options.find((o) => o.value === props.value)?.label ?? props.value} />
			</SelectTrigger>
			<SelectContent>
				{/* Radix Select 的 value 必须匹配某个 item 才能打开：空值走哨兵 value，
				   补一个隐藏 item 保证下拉始终可展开（社区标准模式） */}
				{props.value === "" && <SelectItem value={SENTINEL} className="hidden" aria-hidden="true" />}
				{props.options.map((option) => (
					<SelectItem key={option.value || "none"} value={option.value === "" ? SENTINEL : option.value}>
						{option.label}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

/**
 * 通用 combobox 输入框：支持下拉选择 + 手动输入，选项支持文本过滤。
 * 用于 settings 中 defaultProvider / defaultModel 等需要从已有配置选取但又允许自定义的场景。
 */
export function ConfigComboboxInput(props: {
	value: string;
	options: Array<{ value: string; label?: string }>;
	onChange: (value: string) => void;
	placeholder?: string;
	/** 右侧额外预留清除按钮空间（defaultProvider/defaultModel 清空场景），
	 *  避免输入文字被清除按钮盖住 */
	clearSpace?: boolean;
}) {
	const [open, setOpen] = useState(false);
	const [filter, setFilter] = useState("");
	const containerRef = useRef<HTMLDivElement>(null);

	// 点击外部时立即关闭下拉，避免多个 combobox 同时展开重叠
	useEffect(() => {
		if (!open) return;
		const handlePointerDown = (event: PointerEvent) => {
			if (!containerRef.current?.contains(event.target as Node)) {
				setOpen(false);
			}
		};
		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") setOpen(false);
		};
		document.addEventListener("pointerdown", handlePointerDown);
		document.addEventListener("keydown", handleKeyDown);
		return () => {
			document.removeEventListener("pointerdown", handlePointerDown);
			document.removeEventListener("keydown", handleKeyDown);
		};
	}, [open]);

	// 输入框获得焦点时打开下拉，并清空过滤文本以显示全部选项
	const handleFocus = () => {
		setFilter("");
		setOpen(true);
	};

	// 根据过滤文本筛选选项，支持 label 和 value 双向匹配
	const filtered = filter
		? props.options.filter(
				(opt) =>
					opt.value.toLowerCase().includes(filter.toLowerCase()) ||
					(opt.label ?? opt.value).toLowerCase().includes(filter.toLowerCase()),
			)
		: props.options;

	return (
		<div ref={containerRef} className="relative min-w-0 flex-1">
			<Input
				value={open ? filter : props.value}
				onFocus={handleFocus}
				onChange={(e) => {
					setFilter(e.target.value);
					props.onChange(e.target.value);
					setOpen(true);
				}}
				placeholder={props.placeholder}
				className={`h-8 min-w-0 w-full flex-1 rounded-sm border border-border-subtle bg-bg-panel px-3 text-control text-text-primary outline-none focus:border-[var(--color-accent)] focus:shadow-[var(--focus-ring)]${props.clearSpace ? " pr-[62px]" : " pr-[38px]"}`}
			/>
			<Button
				type="button"
				variant="ghost"
				size="icon-sm"
				className="absolute top-px right-px size-[34px] rounded-l-none border-l border-border-subtle text-text-tertiary hover:bg-bg-hover hover:text-text-primary"
				onMouseDown={(e) => {
					e.preventDefault();
					if (open) {
						setOpen(false);
					} else {
						setFilter("");
						setOpen(true);
					}
				}}
			>
				<ChevronDown size={14} />
			</Button>
			{open && (
				<div className="absolute top-[calc(100%+4px)] right-0 left-0 z-30 max-h-[220px] overflow-y-auto rounded-lg border border-border-subtle bg-bg-panel p-[5px] shadow-[var(--shadow-popover)]">
					{filtered.length === 0 && (
						<div className="config-combobox-empty">{t("config.noMatchingOptions")}</div>
					)}
					{filtered.map((option) => (
						<Button
							key={option.value}
							type="button"
							variant="ghost"
							size="sm"
							className={`h-auto min-h-[30px] w-full justify-start rounded-sm px-[9px] py-1.5 text-xs${option.value === props.value ? " bg-bg-active text-[color:var(--color-accent)]" : ""}`}
							onMouseDown={(e) => {
								e.preventDefault();
								props.onChange(option.value);
								setOpen(false);
							}}
						>
							{option.label ?? option.value}
						</Button>
					))}
				</div>
			)}
		</div>
	);
}

/** API 类型选择：shadcn Select（与全局下拉交互/动画一致）。
 *  预定义选项 + 描述；当前值为自定义值时动态追加「自定义」选项保留可读性。 */
export function ApiTypeInput(props: {
	value: string;
	onChange: (value: string) => void;
}) {
	const isCustom = Boolean(props.value) && !PROVIDER_API_OPTIONS.includes(props.value);
	return (
		<Select
			value={props.value || SENTINEL}
			onValueChange={(value) => props.onChange(value === SENTINEL ? "" : value)}
		>
			<SelectTrigger className="config-select-trigger">
				{/* 选中后只显示名称（title），描述仅在下拉选项里展示：
				   不用 SelectValue 的自动文本（会连描述一起显示） */}
				<span className="flex min-w-0 flex-1 items-center truncate">
					{props.value
						? (API_TYPE_LABELS[props.value] || props.value)
						: <span className="text-muted-foreground">{t("config.apiTypePlaceholder")}</span>}
				</span>
			</SelectTrigger>
			<SelectContent>
				{/* 空值（无 API 类型）时补隐藏哨兵 item，保证下拉可展开 */}
				{!props.value && <SelectItem value={SENTINEL} className="hidden" aria-hidden="true" />}
				{isCustom && (
					<SelectItem value={props.value}>
						<span className="flex flex-col items-start gap-0.5">
							<span className="text-control font-semibold">{t("config.apiTypeCustom")}: {props.value}</span>
							<small className="text-[11px] leading-[1.4] text-text-tertiary">{props.value}</small>
						</span>
					</SelectItem>
				)}
				{PROVIDER_API_OPTIONS.map((option) => (
					<SelectItem key={option} value={option}>
						<span className="flex flex-col items-start gap-0.5">
							<span className="text-control font-semibold">{API_TYPE_LABELS[option] || option}</span>
							<small className="text-[11px] leading-[1.4] text-text-tertiary">{getApiTypeDescription(option)}</small>
						</span>
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

