import { useMemo } from "react";
import { ExternalLink } from "lucide-react";
import { t } from "../../../i18n";
import { Button } from "../../ui-shadcn/button";
import { FileDiff } from "../../agents/file-diff";
import { createTurnFileDiffSource } from "./turnFileDiffSource";
import type { DiffFileHandler } from "../ToolCallComponents";

/**
 * 「本轮文件修改」里的单文件行：文件名 + 内联 FileDiff + 右侧差异查看器入口。
 *
 * 行数据走惰性 source：收起时只显示文件名与增删计数，不拆全文、不构造行数组、
 * 不跑高亮；展开后才真正构造。
 */
export function TurnFileChangeRow(props: {
	path: string;
	count: number;
	originalContent: string;
	content: string;
	streaming?: boolean;
	onDiffFile?: DiffFileHandler;
}) {
	const { originalContent, content } = props;
	const lineSource = useMemo(
		() => createTurnFileDiffSource({ originalContent, content }),
		[originalContent, content],
	);
	return (
		<div className="flex items-center gap-1">
			<FileDiff
				className="min-w-0 flex-1 [&>button]:min-h-6 [&>button]:py-0"
				// 同文件多次修改时在路径后附次数（truncate 由 FileDiff 内部处理）
				file={`${props.path}${props.count > 1 ? ` ×${props.count}` : ""}`}
				lineSource={lineSource}
				status={props.streaming ? "streaming" : "complete"}
				defaultOpen={false}
				maxHeight={200}
				language="diff"
			/>
			<Button
				type="button"
				variant="ghost"
				size="icon-sm"
				className="size-6 shrink-0 rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
				title={t("session.openInDiffViewer", { path: props.path })}
				onClick={() => props.onDiffFile?.(props.path, originalContent, content)}
			>
				<ExternalLink size={13} />
			</Button>
		</div>
	);
}
