import React, { useLayoutEffect } from "react";
import { Streamdown, defaultRemarkPlugins, defaultRehypePlugins, type Components, type StreamdownProps } from "streamdown";
import { code } from "@streamdown/code";
import { createMathPlugin } from "@streamdown/math";
import type { ExportDocumentModel } from "./imageExportModel";
import { formatTime, stripAnsi } from "../TimelineFormat";

const mathPlugin = createMathPlugin({ singleDollarTextMath: true });
const staticRemarkPlugins = [defaultRemarkPlugins.gfm, defaultRemarkPlugins.codeMeta];
const staticRehypePlugins = [defaultRehypePlugins.raw];
const exportComponents: Components = {
	a: (linkProps) => (
		<span className="underline text-primary" {...(linkProps as unknown as React.HTMLAttributes<HTMLSpanElement>)}>
			{linkProps.children}
		</span>
	),
};

export function StaticExportMarkdown(props: { text: string }) {
	const clean = stripAnsi(props.text);
	return (
		<div className="assistant-text markdown-body select-text">
			<Streamdown
				mode="static"
				isAnimating={false}
				remarkPlugins={staticRemarkPlugins}
				rehypePlugins={staticRehypePlugins}
				plugins={{ code, math: mathPlugin } as StreamdownProps["plugins"]}
				components={exportComponents}
			>
				{clean}
			</Streamdown>
		</div>
	);
}

/**
 * 纯只读的多选导出 Markdown/正文渲染组件。
 * 遵循计划步骤 10 要求：
 * - 不经过 MarkdownStream / useSmoothStream；
 * - 链接只读，无交互悬停或点击；
 * - 带有 data-markdown-readonly 标识，阻断 FormulaCopyLayer 污染；
 * - 根 useLayoutEffect 触发 onRenderCommit 通知容器真实 DOM 已挂载完成。
 */
export function ReadOnlyExportDocument(props: {
	model: ExportDocumentModel;
	onRenderCommit?: () => void;
}) {
	const { model, onRenderCommit } = props;

	useLayoutEffect(() => {
		onRenderCommit?.();
	}, [onRenderCommit]);

	return (
		<div
			className="export-content flex flex-col w-full text-text-primary"
			data-markdown-readonly="true"
		>
			{model.items.map((item, index) => {
				if (item.kind === "message") {
					const msg = item.message;
					const isUser = msg.role === "user";
					return (
						<div
							key={msg.id || index}
							className={`export-message-row mb-4 flex flex-col ${
								isUser ? "items-end" : "items-start"
							}`}
							data-role={msg.role}
						>
							<div className="text-micro text-muted-foreground mb-1 font-mono">
								{msg.role.toUpperCase()} • {formatTime(msg.timestamp)}
							</div>
							<div
								className={`rounded-lg px-4 py-3 max-w-[85%] text-sm ${
									isUser
										? "bg-primary text-primary-foreground"
										: "border border-border bg-card text-card-foreground shadow-xs"
								}`}
							>
								<div className="whitespace-pre-wrap break-words leading-relaxed">
									{stripAnsi(msg.text)}
								</div>
								{msg.images && msg.images.length > 0 && (
									<div className="mt-2 flex flex-wrap gap-2">
										{msg.images.map((img, idx) => (
											<img
												key={idx}
												src={`data:${img.mimeType};base64,${img.data}`}
												alt="export-media"
												className="size-24 rounded-md border border-border object-cover"
												loading="eager"
											/>
										))}
									</div>
								)}
							</div>
						</div>
					);
				}

				if (item.kind === "agent-run") {
					return (
						<div
							key={item.id || index}
							className="export-agent-run mb-6 flex flex-col items-start w-full"
						>
							<div className="w-full space-y-3">
								{item.items.map((sub, idx) => {
									if (sub.kind === "message") {
										const msg = sub.message;
										return (
											<div
												key={msg.id || idx}
												className="export-answer-content rounded-lg border border-border bg-card px-4 py-3 text-sm text-card-foreground shadow-xs"
											>
												<StaticExportMarkdown text={msg.text} />
												{msg.images && msg.images.length > 0 && (
													<div className="mt-2 flex flex-wrap gap-2">
														{msg.images.map((img, i) => (
															<img
																key={i}
																src={`data:${img.mimeType};base64,${img.data}`}
																alt="export-media"
																className="size-24 rounded-md border border-border object-cover"
																loading="eager"
															/>
														))}
													</div>
												)}
											</div>
										);
									}

									if (sub.kind === "thinking") {
										return (
											<div
												key={sub.thinking.id || idx}
												className="export-thinking-block rounded-md border border-dashed border-border bg-muted/40 p-3 text-xs text-muted-foreground"
											>
												<div className="font-semibold mb-1 font-mono uppercase tracking-wider text-[11px]">
													THINKING
												</div>
												<div className="whitespace-pre-wrap leading-relaxed">
													{stripAnsi(sub.thinking.thinkingText)}
												</div>
											</div>
										);
									}

									if (sub.kind === "tool") {
										const t = sub.tool;
										return (
											<div
												key={t.id || idx}
												className="export-tool-card rounded-md border border-border/70 bg-muted/20 p-3 text-xs text-muted-foreground space-y-2"
											>
												<div className="font-semibold font-mono text-[11px] text-text-primary">
													TOOL: {t.toolName}
												</div>
												{t.argsText && (
													<div className="space-y-1">
														<div className="font-mono text-[10px] text-muted-foreground">ARGUMENTS:</div>
														<pre className="font-mono text-[10px] bg-background/50 p-2 rounded border border-border/40 overflow-x-auto whitespace-pre-wrap">
															{t.argsText}
														</pre>
													</div>
												)}
												<div className="space-y-1">
													<div className="font-mono text-[10px] text-muted-foreground">RESULT:</div>
													<div className="whitespace-pre-wrap font-mono text-[11px] leading-relaxed break-words bg-background/30 p-2 rounded border border-border/30">
														{stripAnsi(t.detailText || t.resultText || "")}
													</div>
												</div>
												{t.detailsText && (
													<div className="space-y-1">
														<div className="font-mono text-[10px] text-muted-foreground">DETAILS:</div>
														<pre className="font-mono text-[10px] bg-background/50 p-2 rounded border border-border/40 overflow-x-auto whitespace-pre-wrap">
															{t.detailsText}
														</pre>
													</div>
												)}
												{t.images && t.images.length > 0 && (
													<div className="mt-2 flex flex-wrap gap-2">
														{t.images.map((img, i) => (
															<img
																key={i}
																src={`data:${img.mimeType};base64,${img.data}`}
																alt="tool-media"
																className="size-20 rounded-md border border-border object-cover"
																loading="eager"
															/>
														))}
													</div>
												)}
											</div>
										);
									}

									return null;
								})}
							</div>
						</div>
					);
				}

				return null;
			})}
		</div>
	);
}
