import { useState, type ReactNode } from "react";
import { Check, ChevronLeft, ChevronRight, CornerUpLeft, GitFork } from "lucide-react";
import type { SessionRecord } from "../../../../shared/types";
import { t } from "../../i18n";
import { Button } from "../ui-shadcn/button";
import { Popover, PopoverContent, PopoverTrigger } from "../ui-shadcn/popover";
import type { BranchFamily } from "./branchFamily";

const NO_DRAG = "[-webkit-app-region:no-drag] [&_*]:[-webkit-app-region:no-drag]";

/** Keep untitled imported sessions recognizable in the navigation menu. */
function branchTitle(record: SessionRecord): string {
	return record.title.trim() || record.preview.trim() || t("app.chatProject");
}

/** One full-width destination, with an explicit current-session marker. */
function BranchMenuItem(props: {
	label: string;
	onSelect: () => void;
	current?: boolean;
	icon?: ReactNode;
}) {
	return (
		<Button
			type="button"
			variant="ghost"
			data-no-window-drag
			className={`h-auto w-full min-w-0 justify-start gap-1.5 rounded-sm px-2 py-1.5 text-body ${NO_DRAG}`}
			title={props.label}
			aria-current={props.current ? "page" : undefined}
			disabled={props.current}
			onClick={props.onSelect}
		>
			{props.current ? <Check className="size-3 shrink-0" aria-hidden="true" /> : props.icon}
			<span className="truncate">{props.label}</span>
		</Button>
	);
}

/** A bounded titlebar trigger preserves all branch actions in its scrollable menu. */
export function SessionBranchMenu(props: { family: BranchFamily; onOpenSession: (sessionId: string) => void }) {
	const [open, setOpen] = useState(false);
	const { parent, siblings, currentIndex, children } = props.family;
	const summary = siblings.length > 1 ? `${currentIndex + 1}/${siblings.length}` : String(children.length || 1);
	const description = [
		t("branch.navigation"),
		parent ? t("branch.parent", { title: branchTitle(parent) }) : "",
		siblings.length > 1 ? `${t("branch.siblingsTitle")} ${t("branch.pager", { index: currentIndex + 1, total: siblings.length })}` : "",
		children.length > 0 ? t("branch.children", { count: children.length }) : "",
	].filter(Boolean).join("\n");
	const select = (sessionId: string) => {
		setOpen(false);
		props.onOpenSession(sessionId);
	};

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					data-no-window-drag
					className={`h-6 max-w-20 shrink-0 gap-1 rounded-sm px-1.5 text-xs text-muted-foreground ${NO_DRAG}`}
					title={description}
					aria-label={description}
				>
					<GitFork className="size-3 shrink-0" aria-hidden="true" />
					<span className="min-w-0 truncate tabular-nums">{summary}</span>
				</Button>
			</PopoverTrigger>
			<PopoverContent
				align="end"
				data-no-window-drag
				aria-label={t("branch.navigation")}
				className={`max-h-[min(24rem,var(--radix-popover-content-available-height))] w-64 overflow-y-auto p-1 ${NO_DRAG}`}
			>
				{parent && (
					<BranchMenuItem
						label={t("branch.parent", { title: branchTitle(parent) })}
						icon={<CornerUpLeft className="size-3 shrink-0" aria-hidden="true" />}
						onSelect={() => select(parent.id)}
					/>
				)}
				{siblings.length > 1 && (
					<section aria-label={t("branch.siblingsTitle")}>
						<div className="flex items-center justify-between gap-2 px-2 pt-1.5 pb-1 text-xs text-muted-foreground">
							<span>{t("branch.siblingsTitle")}</span>
							<span className="inline-flex items-center gap-0.5">
								<Button type="button" variant="ghost" size="icon-sm" data-no-window-drag
									className={`size-5 rounded-sm ${NO_DRAG}`} disabled={currentIndex <= 0}
									title={t("branch.prev")} aria-label={t("branch.prev")}
									onClick={() => select(siblings[currentIndex - 1].id)}>
									<ChevronLeft className="size-3" aria-hidden="true" />
								</Button>
								<span className="tabular-nums">{summary}</span>
								<Button type="button" variant="ghost" size="icon-sm" data-no-window-drag
									className={`size-5 rounded-sm ${NO_DRAG}`} disabled={currentIndex >= siblings.length - 1}
									title={t("branch.next")} aria-label={t("branch.next")}
									onClick={() => select(siblings[currentIndex + 1].id)}>
									<ChevronRight className="size-3" aria-hidden="true" />
								</Button>
							</span>
						</div>
						{siblings.map((sibling, index) => (
							<BranchMenuItem key={sibling.id} label={branchTitle(sibling)}
								current={index === currentIndex} onSelect={() => select(sibling.id)} />
						))}
					</section>
				)}
				{children.length > 0 && (
					<section aria-label={t("branch.childrenTitle")}>
						<div className="px-2 pt-1.5 pb-1 text-xs text-muted-foreground">
							{t("branch.children", { count: children.length })}
						</div>
						{children.map((child) => (
							<BranchMenuItem key={child.id} label={branchTitle(child)} onSelect={() => select(child.id)} />
						))}
					</section>
				)}
			</PopoverContent>
		</Popover>
	);
}
