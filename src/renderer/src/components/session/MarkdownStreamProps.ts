import type { StreamdownProps } from "streamdown";

/** MarkdownStream 对外共享契约；仅含类型，不会把 Streamdown 拉进入口运行时。 */
export type MarkdownStreamProps = {
	text: string;
	isStreaming?: boolean;
	onOpenExternal: (url: string, forceSystem?: boolean) => void;
	onOpenFile?: (path: string) => void;
	/** 静态场景（FileDiffViewer/ScratchPad）可覆盖默认插件。0.2.1 移除 AppUpdateOverlay 后剩两个主要静态场景。 */
	remarkPlugins?: StreamdownProps["remarkPlugins"];
	rehypePlugins?: StreamdownProps["rehypePlugins"];
	urlTransform?: (url: string) => string;
	components?: StreamdownProps["components"];
	/** 是否禁用图表/代码高亮等重型渲染。 */
	light?: boolean;
};
