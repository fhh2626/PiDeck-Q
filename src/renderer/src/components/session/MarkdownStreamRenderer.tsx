import { memo, useContext, useMemo } from "react";
import {
	Streamdown,
	defaultRehypePlugins,
	defaultRemarkPlugins,
	type Components,
	type StreamdownProps,
} from "streamdown";
import { code } from "@streamdown/code";
import { mermaid } from "@streamdown/mermaid";
import { createMathPlugin } from "@streamdown/math";
import { MarkdownLink, remarkLinkifyPaths } from "./MarkdownLink";
import { markdownUrlTransform } from "./MarkdownLinkCore";
import type { MarkdownStreamProps } from "./MarkdownStreamProps";
import { MarkdownFileBasePathContext } from "./MarkdownFileBasePath";
import { MarkdownImage } from "./MarkdownImage";

/**
 * 数学公式插件（KaTeX）。@streamdown/math 默认 singleDollarTextMath: false，
 * AI 输出行内公式普遍使用单美元 $...$，因此显式开启单美元解析。
 */
const mathPlugin = createMathPlugin({ singleDollarTextMath: true });

/**
 * Streamdown 静态渲染管线。
 *
 * 该模块由 MarkdownStream 的动态 import 加载。这样首屏仍可显示流式纯文本，
 * 但只有消息 settle 或静态预览真正出现时才解析 Streamdown/Shiki/Mermaid。
 */
export const MarkdownStreamRenderer = memo(function MarkdownStreamRenderer(
	props: MarkdownStreamProps,
) {
	const isDark = typeof document !== "undefined" &&
		document.documentElement.dataset.theme === "dark";
	const effectiveLight = Boolean(props.light);
	const inheritedFileBasePath = useContext(MarkdownFileBasePathContext);
	const fileBasePath = props.fileBasePath ?? inheritedFileBasePath;
	// 显式传入插件时沿用旧契约（替换默认集合），避免静态预览行为随懒加载改动。
	const resolvedRemarkPlugins = props.remarkPlugins ?? [
		defaultRemarkPlugins.gfm,
		defaultRemarkPlugins.codeMeta,
		remarkLinkifyPaths,
	];
	const resolvedRehypePlugins = props.rehypePlugins ?? [defaultRehypePlugins.raw];

	// useMemo 依赖回调 props：回调引用变化时 components 重建，避免链接处理闭包捕获旧值。
	const components: Components = useMemo(
		() => ({
				a: (linkProps) => (
					<MarkdownLink
						{...(linkProps as unknown as React.AnchorHTMLAttributes<HTMLAnchorElement>)}
						onOpenExternal={props.onOpenExternal}
						onOpenFile={props.onOpenFile}
						basePath={fileBasePath}
					/>
				),
				img: (imageProps) => (
					<MarkdownImage {...imageProps} basePath={fileBasePath} onOpenFile={props.onOpenFile} />
				),
				...props.components,
			}),
		[props.components, props.onOpenExternal, props.onOpenFile, fileBasePath],
	);

	return (
		<Streamdown
			mode="static"
			isAnimating={false}
			remarkPlugins={resolvedRemarkPlugins}
			rehypePlugins={resolvedRehypePlugins}
			urlTransform={props.urlTransform ?? markdownUrlTransform}
			plugins={
				(effectiveLight
					? { math: mathPlugin }
					: {
							code,
							mermaid,
							math: mathPlugin,
						}) as StreamdownProps["plugins"]
			}
			mermaid={{
				config: {
					theme: isDark ? "dark" : "default",
					securityLevel: "strict",
				},
			}}
			components={components}
		>
			{props.text}
		</Streamdown>
	);
});
