import { Button } from "../components/ui-shadcn/button";
import { showNotice } from "../utils/notice";
import { useEffect, useState } from "react";
import { ArrowLeft, Check, Download, Search } from "lucide-react";
import type { YaoPromptListResult, YaoPromptItem, YaoPromptDetailResult, PiPromptTemplateListResult } from "../../../shared/types";
import { t } from "../i18n";
import { desktopApi } from "../desktopApi";
import { Input } from "../components/ui-shadcn/input";
import { Pagination } from "../components/ui-shadcn/pagination";

async function getInstalledPromptNames(): Promise<Set<string>> {
	try {
		const list: PiPromptTemplateListResult = await desktopApi.prompts.list();
		return new Set(list.templates.filter((template) => template.userCreated).map((template) => template.name.toLowerCase()));
	} catch {
		return new Set();
	}
}

export function YaoPromptTab(props: {
	onImported?: () => void;
}) {
	const [initialLoading, setInitialLoading] = useState(true);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	/* toast 已改用 sonner 实现 */
	const [data, setData] = useState<YaoPromptListResult | null>(null);
	const [activeCategory, setActiveCategory] = useState<string | null>(null);
	const [searchQuery, setSearchQuery] = useState("");
	const [page, setPage] = useState(1);
	const [installedNames, setInstalledNames] = useState<Set<string>>(new Set());
	const [previewItem, setPreviewItem] = useState<YaoPromptItem | null>(null);
	const [previewDetail, setPreviewDetail] = useState<YaoPromptDetailResult | null>(null);
	const [previewLoading, setPreviewLoading] = useState(false);
	const [importingSlug, setImportingSlug] = useState<string | null>(null);
	const PAGE_SIZE = 20;

	// 首次加载分类（全量，数据量小）
	useEffect(() => {
		void loadCategories();
	}, []);

	useEffect(() => {
		if (!initialLoading) void loadPrompts();
	}, [activeCategory, initialLoading, page, searchQuery]);

	const loadCategories = async () => {
		setInitialLoading(true);
		setError(null);
		try {
			const [result, installed] = await Promise.all([
				desktopApi.yaoPrompts.list(),
				getInstalledPromptNames(),
			]);
			setData(result);
			setInstalledNames(installed);
			if (result.categories.length > 0 && !activeCategory) {
				setActiveCategory(result.categories[0].slug);
			}
			setInitialLoading(false);
		} catch (err) {
			// 原始错误可能含路径/堆栈，只进日志；用户侧展示稳定的本地化文案。
			console.error("[YaoPrompts] Initial load failed", err);
			setError(t("config.yaoLoadError"));
			setInitialLoading(false);
		}
	};

	;

	const loadPrompts = async () => {
		setLoading(true);
		setError(null);
		try {
			const result = await desktopApi.yaoPrompts.list({
				category: activeCategory ?? undefined,
				search: searchQuery.trim() || undefined,
				page,
				pageSize: PAGE_SIZE,
			});
			setData((previous) => previous ? { ...previous, ...result, categories: previous.categories } : result);
		} catch (err) {
			console.error("[YaoPrompts] Search failed", err);
			setError(t("config.yaoLoadError"));
		} finally {
			setLoading(false);
		}
	};

	const handleCategoryChange = (slug: string | null) => {
		setActiveCategory(slug);
		setPage(1);
	};

	const handleSearchChange = (value: string) => {
		setSearchQuery(value);
		setPage(1);
	};

	const handlePreview = async (item: YaoPromptItem) => {
		setPreviewItem(item);
		setPreviewLoading(true);
		setPreviewDetail(null);
		try {
			const detail = await desktopApi.yaoPrompts.detail(item.slug, item.category);
			setPreviewDetail(detail);
		} catch (err) {
			console.error("[YaoPrompts] Preview failed", err);
			setError(t("config.yaoPreviewError"));
		} finally {
			setPreviewLoading(false);
		}
	};

	const handleImport = async (item: YaoPromptItem) => {
		setImportingSlug(item.slug);
		setError(null);
		try {
			await desktopApi.yaoPrompts.import(item.slug, item.category);
			showNotice(t("config.promptStoreImported"), 2500);
			props.onImported?.();
			setInstalledNames(await getInstalledPromptNames());
		} catch (err) {
			console.error("[YaoPrompts] Import failed", err);
			setError(t("config.yaoImportError"));
		} finally {
			setImportingSlug(null);
		}
	};

	const totalPages = data?.total ? Math.ceil(data.total / PAGE_SIZE) : 0;
	const activePrompts = data?.prompts ?? [];

	// 预览详情视图
	if (previewItem) {
		return (
			<div className="store-sub-tab">
				{error && <div className="mb-3.5 rounded-sm border border-danger/20 bg-danger-soft px-3.5 py-2.5 text-control leading-relaxed text-danger whitespace-pre-line">{error}</div>}
				{/* toast 已改用 sonner */}
				<div className="prompt-store-toolbar">
					<Button size="sm"  variant="outline" onClick={() => { setPreviewItem(null); setPreviewDetail(null); }}>
						<ArrowLeft size={14} strokeWidth={1.8} />
						{t("config.promptStoreBack")}
					</Button>
					<Button
						 size="sm" variant="default"
						onClick={() => void handleImport(previewItem)}
						disabled={importingSlug === previewItem.slug}
					>
						{importingSlug === previewItem.slug ? (
							t("config.promptStoreImporting")
						) : (
							<><Download size={14} strokeWidth={1.8} /> {t("config.promptStoreImport")}</>
						)}
					</Button>
				</div>
				{previewLoading ? (
					<div className="py-12 text-center text-control text-text-tertiary">{t("common.loading")}</div>
				) : previewDetail ? (
					<div className="prompt-store-preview">
						<div className="prompt-store-preview-header">
							<h3>{previewDetail.title}</h3>
							{previewDetail.description && (
								<p className="prompt-store-description">{previewDetail.description}</p>
							)}
						</div>
						<div className="prompt-store-preview-content">
							<pre>{previewDetail.promptContent}</pre>
						</div>
					</div>
				) : null}
			</div>
		);
	}

	return (
		<div className="store-sub-tab">
			{/* 工具栏：搜索 + 更新按钮 */}
			<div className="prompt-store-search-bar">
				<div className="prompt-store-search-input-wrap">
					<Search size={15} strokeWidth={1.8} className="prompt-store-search-icon" />
					<Input
						type="text"
					value={searchQuery}
					onChange={(e) => handleSearchChange(e.target.value)}
					placeholder={t("config.yaoSearchPlaceholder")}
					/>
				</div>
			</div>

			{error && <div className="mb-3.5 rounded-sm border border-danger/20 bg-danger-soft px-3.5 py-2.5 text-control leading-relaxed text-danger whitespace-pre-line">{error}</div>}
			{/* toast 已改用 sonner */}
			{initialLoading ? (
				<div className="py-12 text-center text-control text-text-tertiary">{t("common.loading")}</div>
			) : !data || data.categories.length === 0 ? (
				<div className="py-12 text-center text-control text-text-tertiary">{t("config.yaoNoData")}</div>
			) : (
				<>
					{/* 分类导航 */}
					<div className="yao-category-bar">
						<button
							className={`yao-category-chip ${!activeCategory ? "active" : ""}`}
							onClick={() => handleCategoryChange(null)}
						>
							{t("config.yaoAll")}
							<small>{data.categories.reduce((s, c) => s + c.count, 0)}</small>
						</button>
						{data.categories.map((cat) => (
							<button
								key={cat.slug}
								className={`yao-category-chip ${activeCategory === cat.slug ? "active" : ""}`}
								onClick={() => handleCategoryChange(cat.slug)}
							>
								{cat.name}
								<small>{cat.count}</small>
							</button>
						))}
					</div>

					{/* 提示词列表 */}
				<div className="prompt-store-results">
					{loading ? (
						<div className="py-12 text-center text-control text-text-tertiary">{t("common.loading")}</div>
					) : activePrompts.length === 0 ? (
						<div className="py-12 text-center text-control text-text-tertiary">{t("config.yaoNoMatches")}</div>
						) : (
							activePrompts.map((item) => (
								<article
									key={item.slug}
									className="prompt-store-card"
									onClick={() => void handlePreview(item)}
								>
									<div className="prompt-store-card-main">
										<strong className="prompt-store-card-title">
											{item.title}
											{installedNames.has(item.slug.toLowerCase()) && (
												<span className="prompt-store-installed-badge">
													<Check size={11} /> {t("config.installed")}
												</span>
											)}
										</strong>
										{item.description && (
											<p className="prompt-store-card-desc">{item.description}</p>
										)}
										{item.tags.length > 0 && (
											<div className="yao-card-tags">
												{item.tags.slice(0, 3).map((tag) => (
													<span key={tag} className="prompt-store-tag">{tag}</span>
												))}
											</div>
										)}
									</div>
									<div className="prompt-store-card-actions">
										{!installedNames.has(item.slug.toLowerCase()) && (
											<Button
												 variant="default" size="sm"
												onClick={(e) => { e.stopPropagation(); void handleImport(item); }}
												disabled={importingSlug === item.slug}
											>
												{importingSlug === item.slug ? t("config.promptStoreImporting") : t("config.promptStoreImport")}
											</Button>
										)}
									</div>
								</article>
							))
						)}
					</div>

					{/* 分页控件：共享 Pagination 组件，带 aria-label 与禁用态 */}
					{totalPages > 1 && (
						<Pagination
							page={page}
							totalPages={totalPages}
							onPageChange={setPage}
						/>
					)}
				</>
			)}
		</div>
	);
}
