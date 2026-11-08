import { useEffect, useState } from "react";
import { useAtomValue } from "jotai";
import { FolderGit2, HatGlasses, Plus, Sparkles } from "lucide-react";
import type { AvailableModel, Project, SessionLaunchPreferences } from "../../../../shared/types";
import { t, type TranslationKey } from "../../i18n";
import { desktopApi } from "../../desktopApi";
import { Button } from "../ui-shadcn/button";
import { ModelPicker, ThinkingPicker } from "./ComposerComponents";
import { WELCOME_MODEL_KEY, WELCOME_THINKING_KEY } from "../../utils/chatSessionBootstrap";
import { EmptyState } from "./SurfaceParts";
import { THINKING_LEVELS } from "./sessionPickerOptions";
import { modelListRevisionAtom } from "../../atoms";
import { clampThinkingLevelForModel, findModelThinkingSupport } from "../../../../shared/thinkingLevelSupport";

const THINKING_LABEL_KEYS: Record<string, TranslationKey> = {};
for (const level of THINKING_LEVELS) {
  THINKING_LABEL_KEYS[level.value] = level.labelKey;
}

function thinkingLabel(level: string) {
  return t(THINKING_LABEL_KEYS[level] ?? THINKING_LABEL_KEYS.medium);
}

/** 将引导页当前选择转换为创建会话 IPC 的显式偏好，避免点击时回退到 pi 默认值。 */
function readLaunchPreferences(modelChoice: string, thinkingChoice: string): SessionLaunchPreferences {
  const slash = modelChoice.indexOf("/");
  const provider = slash > 0 ? modelChoice.slice(0, slash) : "";
  const modelId = slash > 0 ? modelChoice.slice(slash + 1) : "";
  return {
    ...(provider && modelId ? { model: { provider, modelId } } : {}),
    ...(thinkingChoice ? { thinkingLevel: thinkingChoice } : {}),
  };
}

/**
 * 项目启动面板：在用户还没有会话时提供明确的工程入口与启动前配置。
 *
 * 有活动项目时展示持久会话、临时对话和模型/思考级别选择；无项目时只保留添加项目入口。
 * 模型与思考级别沿用欢迎页偏好键，确保用户配置会被下一次创建会话使用。
 */
export function ProjectEmptyState(props: {
  activeProject?: Project;
  onCreateAgent: (preferences: SessionLaunchPreferences) => void;
  onCreateAnonymous: (preferences: SessionLaunchPreferences) => void;
  onAddProject: () => void;
}) {
  // 通过 config IPC 读取 pi 的 models.json / settings.json 默认值；读失败时静默降级为空显示。
  // parsed 来自远端配置文件，取值一律先经 unknown 收窄（typeof 守卫）再用，
  // 边界不信任远端结构（AGENTS 输入校验在边界、禁止 as 强转绕过类型错误）。
  const [models, setModels] = useState<AvailableModel[]>([]);
  const [modelChoice, setModelChoice] = useState("");
  const [thinkingChoice, setThinkingChoice] = useState("");
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [thinkingPickerOpen, setThinkingPickerOpen] = useState(false);
  const modelListRevision = useAtomValue(modelListRevisionAtom);
  // 模型列表独立拉取：配置页保存 models.json 后主进程广播 models:changed，空态常驻在
  // 配置弹窗后面时也要重取，否则刚勾选的 xhigh/max 要等空态重挂载才会出现在选择器里。
  useEffect(() => {
    let alive = true;
    void desktopApi.projects.listModels(props.activeProject?.id).then((items) => {
      if (alive) setModels(items);
    }).catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [modelListRevision, props.activeProject?.id]);

  useEffect(() => {
    let alive = true;
    const apply = (model: string | undefined, thinking: string | undefined) => {
      if (alive) {
        setModelChoice(model ?? "");
        setThinkingChoice(thinking ?? "medium");
      }
    };

    // 主进程 sessionsCatalogCreateDraft 的默认规则：优先 pi settings 的
    // defaultProvider/defaultModel，否则回退 models.json 的第一个 provider 的第一个 model。
    // 空态只做展示提示，须与主进程规则保持一致，避免“空态显示与真实默认不同”。
    void desktopApi.config
      .getSettings()
      .then(({ parsed }) => {
        // parsed 为 { defaultProvider?: unknown; defaultModel?: unknown; defaultThinkingLevel?: unknown }
        // 逐字段用 typeof 收窄为 string，未命中即视为缺省（返回 undefined）。
        const provider =
          typeof parsed.defaultProvider === "string" ? parsed.defaultProvider : undefined;
        const modelId =
          typeof parsed.defaultModel === "string" ? parsed.defaultModel : undefined;
        const thinking =
          typeof parsed.defaultThinkingLevel === "string"
            ? parsed.defaultThinkingLevel
            : undefined;
        if (provider && modelId) {
          // pi 配置同时给全 defaultProvider+defaultModel：直接用它，不再查 models.json。
          apply(`${provider}/${modelId}`, thinking);
        } else {
          // settings 未给全默认模型 → 回退 models.json 首 provider 首 model（与主进程一致）。
          void desktopApi.config
            .getModels()
            .then(({ parsed: modelsParsed }) => {
              // models.json 结构：{ providers: { [name]: { models: [{ id }] } } }
              // provider 条目除模型外还可能含密钥等敏感字段；这里只读 provider 名与 model id，
              // 绝不读取或输出其余字段，避免泄露凭据。
              const providersObj =
                modelsParsed.providers && typeof modelsParsed.providers === "object"
                  ? modelsParsed.providers
                  : null;
              const providerName = providersObj
                ? Object.keys(providersObj)[0]
                : undefined;
              const providerEntry = providerName ? providersObj?.[providerName] : undefined;
              const models =
                providerEntry && typeof providerEntry === "object" && "models" in providerEntry
                  ? providerEntry.models
                  : undefined;
              const firstModel =
                Array.isArray(models) && typeof models[0]?.id === "string"
                  ? models[0].id
                  : undefined;
              apply(
                providerName && firstModel ? `${providerName}/${firstModel}` : undefined,
                thinking,
              );
            })
            .catch(() => {
              // models.json 不可读时仅保留 settings 里的思考级别；空态不阻塞。
              apply(undefined, thinking);
            });
        }
      })
      .catch(() => {
        // 配置不可读（非 Electron/网络预览环境）时保持默认空；空态不阻塞。
      });
    return () => {
      alive = false;
    };
  }, []);

  const hasProject = Boolean(props.activeProject);
  const modelSeparator = modelChoice.indexOf("/");
  const currentModel = modelSeparator > 0
    ? { provider: modelChoice.slice(0, modelSeparator), modelId: modelChoice.slice(modelSeparator + 1) }
    : undefined;
  const currentProvider = currentModel?.provider;
  const currentModelId = currentModel?.modelId;
  // 引导页也按 models.json 勾选状态过滤 xhigh/max：与主界面/Web 同一套规则。
  const thinkingSupport = findModelThinkingSupport(models, currentProvider, currentModelId);
  // 初始档位可能来自 pi settings（如 xhigh），但默认模型未在 models.json 声明该档位：
  // 启动前面板与主进程 applyPreferences 的降级结果保持一致，避免显示一个不会生效的档位。
  useEffect(() => {
    if (models.length === 0 || !currentProvider || !currentModelId) return;
    // 模型列表里没有当前默认模型（未认证/配置不完整）时支持位是未知的，不要凭未知降级。
    const targetProvider = currentProvider.toLowerCase();
    const targetModelId = currentModelId.toLowerCase();
    const modelExists = models.some(
      (model) =>
        model.provider.toLowerCase() === targetProvider &&
        model.id.toLowerCase() === targetModelId,
    );
    if (!modelExists) return;
    const support = findModelThinkingSupport(models, currentProvider, currentModelId);
    setThinkingChoice((previous) => {
      const next = clampThinkingLevelForModel(previous, support);
      return next && next !== previous ? next : previous;
    });
  }, [models, currentProvider, currentModelId]);

  // 取路径末段作为页眉右侧的项目名，与侧栏项目行的命名口径一致。
  const activeProjectName = props.activeProject
    ? props.activeProject.path.split(/[\\/]/).filter(Boolean).pop() ?? props.activeProject.path
    : "";

  const saveModelChoice = (value: string) => {
    setModelChoice(value);
    const model = models.find((item) => `${item.provider}/${item.id}` === value);
    if (!model) return;
    // 切到不支持当前 xhigh/max 的模型时同步降级为 high，避免带着无效档位启动会话。
    const nextThinking = clampThinkingLevelForModel(
      thinkingChoice,
      findModelThinkingSupport(models, model.provider, model.id),
    );
    if (nextThinking && nextThinking !== thinkingChoice) saveThinkingChoice(nextThinking);
    try {
      localStorage.setItem(WELCOME_MODEL_KEY, JSON.stringify({ provider: model.provider, modelId: model.id }));
    } catch {
      // 选择仍保留在当前页面；存储不可用时启动流程会回退到 pi 默认值。
    }
  };

  const saveThinkingChoice = (value: string) => {
    setThinkingChoice(value);
    try {
      localStorage.setItem(WELCOME_THINKING_KEY, value);
    } catch {
      // 启动时仍会使用 pi 配置中的思考级别。
    }
  };

  return (
    // chat-pane 为 flex 列容器：EmptyState 的 .empty-state 自带 height:100%，
    // 外层保持纯 flex 子项（min-h-0 允许收缩），避免再包一层固定高度导致品牌区不居中。
    <div className="flex min-h-0 flex-1 flex-col">
      <EmptyState
        hasProject={hasProject}
        onCreate={() => props.onCreateAgent(readLaunchPreferences(modelChoice, thinkingChoice))}
        eyebrow={
          hasProject ? (
            <span className="inline-flex items-center gap-1.5 text-text-secondary">
              <FolderGit2 size={14} aria-hidden="true" className="text-text-tertiary" />
              <span className="max-w-48 truncate">{activeProjectName}</span>
            </span>
          ) : undefined
        }
        actions={
          hasProject ? (
            /* 主从按钮左对齐跟随阅读动线：主按钮用前景/背景反色（浅色下纯黑、暗色下纯白），
               比中性灰 accent 更亮更锐；次按钮降级为下划线文本，hover 一起加深。 */
            <div className="flex flex-wrap items-center gap-6">
              <Button size="lg" className="h-12 rounded-xl bg-foreground px-7 text-background shadow-[0_8px_24px_-8px_rgb(0_0_0/0.35)] transition-all duration-200 hover:-translate-y-px hover:bg-foreground/85 hover:shadow-[0_12px_32px_-8px_rgb(0_0_0/0.4)]" onClick={() => props.onCreateAgent(readLaunchPreferences(modelChoice, thinkingChoice))}>
                <Sparkles className="size-4" aria-hidden="true" />{t("app.createAgent")}
              </Button>
              <Button variant="ghost" size="lg" className="group h-auto px-0 text-sm font-normal text-text-secondary hover:bg-transparent hover:text-foreground" onClick={() => props.onCreateAnonymous(readLaunchPreferences(modelChoice, thinkingChoice))}>
                <HatGlasses className="size-4" aria-hidden="true" />
                <span className="underline decoration-border-strong underline-offset-4 group-hover:decoration-foreground">{t("app.anonymousChatShort")}</span>
              </Button>
            </div>
          ) : (
            <Button size="lg" className="h-12 rounded-xl bg-foreground px-7 text-background shadow-sm hover:bg-foreground/85" onClick={props.onAddProject}>
              <Plus className="size-4" aria-hidden="true" /><span>{t("app.addProject")}</span>
            </Button>
          )
        }
        footer={
          hasProject && props.activeProject ? (
            /* 启动配置作为文档 meta 定义列表：等宽字体 + 浅下划线表达「可改的参数」，
               不再是三个带框控件，与编辑排版同一语言。 */
            <dl className="flex flex-wrap items-baseline gap-x-8 gap-y-2 text-[13px]">
              <div className="flex items-baseline gap-2">
                <dt className="text-text-tertiary">{t("app.model")}</dt>
                <dd>
                  <button
                    type="button"
                    className="max-w-72 truncate align-baseline font-mono font-medium text-text-primary underline decoration-border-subtle underline-offset-4 transition-colors hover:decoration-border-strong"
                    title={modelChoice || t("app.model")}
                    onClick={() => setModelPickerOpen(true)}
                  >
                    {modelChoice || t("app.model")}
                  </button>
                  {modelPickerOpen && (
                    <ModelPicker
                      models={models}
                      current={currentModel}
                      favoriteModels={[]}
                      onClose={() => setModelPickerOpen(false)}
                      onPick={(model) => {
                        saveModelChoice(`${model.provider}/${model.id}`);
                        setModelPickerOpen(false);
                      }}
                    />
                  )}
                </dd>
              </div>
              <div className="flex items-baseline gap-2">
                <dt className="text-text-tertiary">{t("app.think")}</dt>
                <dd>
                  <button
                    type="button"
                    className="align-baseline font-mono font-medium text-text-primary underline decoration-border-subtle underline-offset-4 transition-colors hover:decoration-border-strong"
                    title={thinkingLabel(thinkingChoice)}
                    onClick={() => setThinkingPickerOpen(true)}
                  >
                    {thinkingLabel(thinkingChoice)}
                  </button>
                  {thinkingPickerOpen && (
                    <ThinkingPicker
                      current={thinkingChoice}
                      support={thinkingSupport}
                      onClose={() => setThinkingPickerOpen(false)}
                      onPick={(level) => {
                        saveThinkingChoice(level);
                        setThinkingPickerOpen(false);
                      }}
                    />
                  )}
                </dd>
              </div>
            </dl>
          ) : undefined
        }

      />
    </div>
  );
}
