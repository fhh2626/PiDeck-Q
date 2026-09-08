import type { ReactNode } from "react";
import { cn } from "../../../lib/utils";
import { t } from "../../../i18n";
import { Switch } from "../../ui-shadcn/switch";
import { Textarea } from "../../ui-shadcn/textarea";

/** 已修改但未保存的字段标记：在标签右侧显示一个黄色圆点 */
export function DirtyMarker(props: { dirty: boolean; label: string }) {
	if (!props.dirty) return null;
	return (
		<span
			className="setting-dirty-marker"
			title={t("settings.dirtyTooltip")}
			aria-label={props.label}
		/>
	);
}

/**
 * 设置内容淡色框：包住一级标题下的二级内容行。
 * 四角圆弧、极淡底色（bg-muted 30%）+ 淡边框；行间分隔线由 SettingRow 自身提供。
 */
export function SettingBox(props: { children: ReactNode }) {
	return (
		<div className="rounded-md border border-border-subtle/70 bg-bg-muted/30 px-0.5 pb-0.5">
			{props.children}
		</div>
	);
}

/**
 * 设置行（UI 2.0 行式布局）：label 左 + 控件右（固定 260px 列），
 * 行间无分隔线（淡色框内由留白分区）。
 *
 * - level=1：一级标题行（单行分区合并用，加粗加大、缩进更小）；
 * - level=2：普通行（标题略缩进，形成与一级的层级差）；
 * - stacked：超长控件（文本输入 / textarea）降级为单列，控件占满整行；
 * - 描述文字不设最大宽度上限，占满左侧列。
 */
export function SettingRow(props: {
	title: ReactNode;
	description?: ReactNode;
	/** 单列堆叠：label 在上、控件占满整行（文本输入 / textarea 等） */
	stacked?: boolean;
	/** 控件右对齐（开关/按钮/步进器默认 true；select 传 false 撑满 260px 列） */
	alignEnd?: boolean;
	/** 1=一级标题行（单行分区合并，加粗加大）；2=普通行（默认） */
	level?: 1 | 2;
	children: ReactNode;
}) {
	const level = props.level ?? 2;
	return (
		<div
			className={cn(
				"grid gap-4 border-t border-border-subtle/60 py-0.5 first:border-t-0",
				level === 1 ? "px-0.5" : "px-1",
				props.stacked
					? "min-h-0 grid-cols-1 items-start"
					: "min-h-9 grid-cols-[minmax(0,1fr)_260px] items-center",
			)}
		>
			<span className="min-w-0">
				<span
					className={cn(
						"inline-flex items-center gap-1.5 text-foreground",
						level === 1
							? "text-body font-bold"
							: "text-control font-medium",
					)}
				>
					{props.title}
				</span>
				{props.description && (
					<small className="mt-0.5 block text-caption leading-normal text-muted-foreground">
						{props.description}
					</small>
				)}
			</span>
			<span
				className={cn(
					"min-w-0",
					!props.stacked && (props.alignEnd ?? true) && "flex justify-end",
				)}
			>
				{props.children}
			</span>
		</div>
	);
}

/** 开关行：标题/描述在左，Switch 右对齐控件列 */
export function SettingSwitchRow(props: {
	title: ReactNode;
	description?: ReactNode;
	checked: boolean;
	disabled?: boolean;
	onChange: (checked: boolean) => void;
}) {
	return (
		<SettingRow title={props.title} description={props.description}>
			<Switch
				checked={props.checked}
				disabled={props.disabled}
				onCheckedChange={props.onChange}
			/>
		</SettingRow>
	);
}

/** 长文本设置项：标题/描述在上，textarea 占满整行 */
export function SettingTextarea(props: {
	title: ReactNode;
	description?: ReactNode;
	value: string;
	onChange: (value: string) => void;
}) {
	return (
		<SettingRow title={props.title} description={props.description} stacked>
			<Textarea
				value={props.value}
				rows={8}
				onChange={(event) => props.onChange(event.target.value)}
				className="min-h-24 w-full resize-y border-border-subtle bg-bg-input px-2.5 py-1.5 font-mono text-sm leading-relaxed text-foreground"
			/>
		</SettingRow>
	);
}
