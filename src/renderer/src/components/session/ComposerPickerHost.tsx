import { useAtomValue, useSetAtom, useStore } from "jotai";
import { useEffect, useRef, useState } from "react";
import type { AvailableModel, SessionRuntimeTarget } from "../../../../shared/types";
import {
  modelPendingAtomFamily,
  modelPendingByIdAtom,
  sessionComposerModeAtomFamily,
  sessionRecordByIdAtomFamily,
  sessionRuntimeByIdAtom,
  sessionRuntimeBySessionIdAtomFamily,
  setSessionComposerModeAtom,
  thinkingLevelPendingAtomFamily,
  thinkingLevelPendingByIdAtom,
  upsertSessionAtom,
} from "../../atoms";
import type { PromptTemplateInfo } from "../../composerBehavior";
import {
  ComposerModePicker,
  ModelPicker,
  PromptTemplatePicker,
  ThinkingPicker,
} from "./ComposerParts";
import { desktopApi } from "../../desktopApi";
import { showNotice } from "../../utils/notice";
import { t } from "../../i18n";
import {
  SessionCommandFailure,
  requireSessionCommand,
  toSessionRuntimeTarget,
} from "../../utils/sessionCommands";
import { ConfirmDialog } from "../app/AppParts";
import { useSessionPaneActions } from "./SessionPaneServices";
import { usePendingModelApply } from "../../hooks/usePendingModelApply";
import { clampThinkingLevelForModel, findModelThinkingSupport, isExtendedThinkingLevel } from "../../../../shared/thinkingLevelSupport";
import type { ComposerPickerKind } from "../../hooks/useSessionComposerController";
import { WELCOME_MODEL_KEY, WELCOME_THINKING_KEY, readWelcomeModelPreference, readWelcomeThinkingPreference } from "../../utils/chatSessionBootstrap";

export type ComposerPickerHostProps = {
  sessionId: string;
  picker: ComposerPickerKind | null;
  templates: PromptTemplateInfo[];
  onClose: () => void;
  onInsertTemplate: (template: PromptTemplateInfo) => void;
};

export function ComposerPickerHost(props: ComposerPickerHostProps) {
  const { sessionId } = props;
  const store = useStore();
  const record = useAtomValue(sessionRecordByIdAtomFamily(sessionId));
  const runtime = useAtomValue(sessionRuntimeBySessionIdAtomFamily(sessionId));
  const setMode = useSetAtom(setSessionComposerModeAtom);
  const upsertSession = useSetAtom(upsertSessionAtom);
  const thinkingPending = useAtomValue(thinkingLevelPendingAtomFamily(sessionId));
  const setThinkingPendingMap = useSetAtom(thinkingLevelPendingByIdAtom);
  const modelPending = useAtomValue(modelPendingAtomFamily(sessionId));
  const setModelPendingMap = useSetAtom(modelPendingByIdAtom);
  const [models, setModels] = useState<AvailableModel[]>([]);
  // 按会话订阅：别的会话切模式不应重渲染本栏选择器。
  const composerMode = useAtomValue(sessionComposerModeAtomFamily(sessionId));
  const [favoriteModels, setFavoriteModels] = useState<string[]>([]);
  const [planModeAvailable, setPlanModeAvailable] = useState(true);
  const modelLoadSequenceRef = useRef(0);
  /** 模型在本地 models.json 存在但运行中 Agent 未加载：待确认重启的目标。 */
  const [restartTarget, setRestartTarget] = useState<{
    handle: SessionRuntimeTarget;
    model: string;
  } | null>(null);
  const [restarting, setRestarting] = useState(false);
  // 与 Tab 栏「重启」共用 App.restartActiveAgent：置 restartingAgentId，
  // SessionView overlay（loader + 文案）才会亮。选择器自己调 restartRuntime
  // 能换进程，但不会驱动那套 UI 状态。
  // 只订 actions 轨：restartActiveAgent 是稳定回调，不随 terminal / gitInfo / agents 变化
  const { restartActiveAgent } = useSessionPaneActions();
  // 不跟 restartTarget state 同步：ConfirmDialog 点确定会先 onOpenChange(false)
  // 走 onCancel 清掉 state；确认意图放 ref，避免当成取消后丢数据。
  const restartIntentRef = useRef<{
    agentId: string;
    provider: string;
    modelId: string;
  } | null>(null);
  const confirmingRestartRef = useRef(false);

  useEffect(() => {
    void desktopApi.settings.get().then((settings) => {
      setFavoriteModels(settings.favoriteModels ?? []);
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (props.picker !== "mode") return;
    // 计划模式由内置扩展提供；每次打开模式选择器读取最新状态，避免禁用扩展后仍显示过期选项。
    const extensionsApi = (window as unknown as {
      piDesktop?: { extensions?: { list: () => Promise<{ extensions: Array<{ source: string; enabled?: boolean; builtIn?: boolean }> }> } };
    }).piDesktop?.extensions;
    if (!extensionsApi) return;
    void extensionsApi.list().then((result) => {
      const plan = result.extensions.find((extension) => extension.source === "pi-deck-plan-mode.ts");
      const available = plan?.enabled !== false;
      setPlanModeAvailable(available);
      // 扩展被禁用后清理残留的计划模式状态，避免下拉隐藏但编辑器仍保持计划模式。
      if (!available && composerMode === "plan") setMode({ sessionId, mode: "normal" });
    }).catch(() => {
      setPlanModeAvailable(false);
      if (composerMode === "plan") setMode({ sessionId, mode: "normal" });
    });
  }, [composerMode, props.picker, sessionId, setMode]);

  useEffect(() => {
    // 打开模型/思考级别选择器即加载（不依赖 record：欢迎页/未启动 Agent 时 record 为 undefined，
    // 但模型列表是全量的，listModels 不依赖 projectId）。
    // 思考级别选择器需要 thinkingLevels 支持位来判断 xhigh/max 是否展示。
    if (props.picker !== "model" && props.picker !== "thinking") return;
    const sequence = ++modelLoadSequenceRef.current;
    // Always read models.json directly — same source as Agent RPC, no transition flicker
    void desktopApi.projects.listModels(record?.projectId).then((next) => {
      if (sequence === modelLoadSequenceRef.current) setModels(next);
    }).catch((error) => {
      if (sequence === modelLoadSequenceRef.current) {
        setModels([]);
        showNotice(error instanceof Error ? error.message : String(error), 4000);
      }
    });
  }, [props.picker, record]);

  function currentHandle() {
    const current = store.get(sessionRuntimeByIdAtom)[sessionId];
    return toSessionRuntimeTarget(sessionId, current);
  }

  /**
   * 运行时代理命令失败时，若错误是「运行时不可用/绑定已变化」（例如 Agent 已被关闭、
   * 或历史会话尚未启动 Agent），降级为只更新会话记录。Agent 下次启动时
   * SessionRuntimeCoordinator.applyPreferences 会把记录里的模型应用到新进程。
   */
  function isStaleRuntimeFailure(error: unknown): boolean {
    return error instanceof SessionCommandFailure &&
      (error.code === "SESSION_RUNTIME_UNAVAILABLE" ||
        error.code === "SESSION_RUNTIME_CHANGED");
  }

  async function applyModelToRecord(model: AvailableModel, thinkingLevel?: string) {
    const updated = await desktopApi.sessions.updateRecord(sessionId, {
      model: { provider: model.provider, modelId: model.id },
      ...(thinkingLevel ? { thinkingLevel } : {}),
    });
    upsertSession(updated);
  }

  /** 模型切换/落记录的档位降级：扩展档位未被模型声明时退回 high（主进程同策略兜底）。 */
  function clampedThinkingForModel(model: { provider: string; id: string }): string | undefined {
    const next = clampThinkingLevelForModel(
      record?.thinkingLevel,
      findModelThinkingSupport(models, model.provider, model.id),
    );
    // 仅返回「需要变更」的值：无变化时不重复写 catalog/updatedAt。
    return next && next !== record?.thinkingLevel ? next : undefined;
  }

  function currentLiveModel() {
    return {
      provider: runtime?.state?.provider || record?.model?.provider || "",
      modelId: runtime?.state?.modelId || record?.model?.modelId || "",
      modelName: runtime?.state?.modelName,
    };
  }

  function markModelPending(model: AvailableModel) {
    const live = currentLiveModel();
    const from = modelPending?.from ?? {
      provider: live.provider,
      modelId: live.modelId,
      modelName: live.modelName,
    };
    if (from.provider === model.provider && from.modelId === model.id) {
      setModelPendingMap((prev) => ({ ...prev, [sessionId]: undefined }));
      return;
    }
    setModelPendingMap((prev) => ({
      ...prev,
      [sessionId]: {
        from,
        to: {
          provider: model.provider,
          modelId: model.id,
          modelName: model.name ?? model.id,
        },
      },
    }));
  }

  function offerModelRestart(handle: SessionRuntimeTarget, model: AvailableModel) {
    props.onClose();
    restartIntentRef.current = {
      agentId: handle.agentId,
      provider: model.provider,
      modelId: model.id,
    };
    setRestartTarget({
      handle,
      model: `${model.provider}/${model.id}`,
    });
  }

  function applyRuntimeModelState(agentState: {
    provider?: string;
    modelId?: string;
    modelName?: string;
    thinkingLevel?: string;
  }) {
    const current = store.get(sessionRuntimeByIdAtom)[sessionId];
    if (current) {
      store.set(sessionRuntimeByIdAtom, {
        ...store.get(sessionRuntimeByIdAtom),
        [sessionId]: {
          ...current,
          state: current.state ? { ...current.state, ...agentState } : agentState,
        },
      });
    }
    // 只同步扩展档位的真实变化（xhigh/max → high，或 pi 拒绝恢复）。
    // 基础档位不跟 pi 切模型时的默认值走，否则 high 会被写成 low 并在下次启动丢失。
    const recordNow = store.get(sessionRecordByIdAtomFamily(sessionId));
    const reportedThinking = agentState.thinkingLevel;
    if (
      reportedThinking &&
      recordNow?.thinkingLevel &&
      isExtendedThinkingLevel(recordNow.thinkingLevel) &&
      recordNow.thinkingLevel !== reportedThinking
    ) {
      upsertSession({
        ...recordNow,
        thinkingLevel: reportedThinking,
        updatedAt: Date.now(),
      });
    }
  }

  usePendingModelApply({
    sessionId,
    runtime,
    modelPending,
    applyRuntimeModelState,
    clearPending: () => setModelPendingMap((prev) => ({ ...prev, [sessionId]: undefined })),
    offerRestart: offerModelRestart,
  });

  /**
   * 生成进行中：pi 不支持运行中切模型。快照里已有的模型只写会话记录，
   * 本轮结束后由本组件再调 setRuntimeModel；不在快照里的新加模型走重启确认。
   */
  async function pickModelWhileBusy(handle: SessionRuntimeTarget, model: AvailableModel) {
    try {
      const listed = requireSessionCommand(await desktopApi.sessions.listRuntimeModels(handle));
      const snapshotHasModel = listed.value.some(
        (item) => item.provider === model.provider && item.id === model.id,
      );
      if (!snapshotHasModel) {
        offerModelRestart(handle, model);
        return;
      }
    } catch {
      // 查快照失败（含生成中 busy）不挡选择：先记下，本轮结束后 setRuntimeModel 再判断要不要重启。
    }
    await applyModelToRecord(model, clampedThinkingForModel(model));
    markModelPending(model);
    props.onClose();
  }

  async function pickModel(model: AvailableModel) {
    // 欢迎页/未启动 Agent（无 record）：把选择存本地偏好，点「启动 Agent」创建会话时应用。
    if (!record) {
      try {
        localStorage.setItem(WELCOME_MODEL_KEY, JSON.stringify({
          provider: model.provider,
          modelId: model.id,
        }));
        // 欢迎页偏好也要跟随模型能力：否则新会话启动时才由主进程降级，
        // 期间底栏/启动参数仍会显示不支持的 xhigh/max。
        const welcomeThinking = readWelcomeThinkingPreference()?.thinkingLevel;
        const nextThinking = clampThinkingLevelForModel(
          welcomeThinking,
          findModelThinkingSupport(models, model.provider, model.id),
        );
        if (nextThinking && nextThinking !== welcomeThinking) {
          localStorage.setItem(WELCOME_THINKING_KEY, nextThinking);
        }
      } catch {
        // localStorage 不可用时静默；创建会话回退到 pi 默认模型
      }
      props.onClose();
      return;
    }
    const handle = currentHandle();
    const generationInFlight =
      Boolean(handle) &&
      (runtime?.status === "running" || Boolean(runtime?.state?.isStreaming));
    // 目标模型不支持当前 xhigh/max 时立即降级为 high（与主进程策略一致）：
    // 无运行时写记录、运行时由主进程 setRuntimeModel 真实降级并回传 state。
    const fallbackThinking = clampedThinkingForModel(model);
    try {
      if (handle && generationInFlight) {
        await pickModelWhileBusy(handle, model);
        return;
      }
      if (handle) {
        try {
          const result = requireSessionCommand(await desktopApi.sessions.setRuntimeModel(
            handle,
            model.provider,
            model.id,
          ));
          const reportedThinking = result.value.thinkingLevel;
          const nextThinking = reportedThinking && reportedThinking.length > 0
            ? reportedThinking
            : fallbackThinking;
          // 与主进程一致：只有扩展档位发生真实变化才改本地记录。
          // pi 切模型顺手改掉的 low/medium/high 不能覆盖用户原来的选择。
          const persistThinking = Boolean(
            nextThinking &&
            record.thinkingLevel &&
            isExtendedThinkingLevel(record.thinkingLevel) &&
            nextThinking !== record.thinkingLevel,
          );
          upsertSession({
            ...record,
            model: { provider: model.provider, modelId: model.id },
            ...(persistThinking ? { thinkingLevel: nextThinking } : {}),
            updatedAt: Date.now(),
          });
          setModelPendingMap((prev) => ({ ...prev, [sessionId]: undefined }));
          // 立即将返回的 AgentRuntimeState 合并到 runtime state atom，
          // 使底部栏的模型名称、provider 即刻刷新，无需等待 emitState 事件
          applyRuntimeModelState(result.value);
        } catch (error) {
          // 运行时代理不可用（Agent 已关/绑定已换）时降级写记录，
          // 保证「先选模型、后启动 Agent」的流程始终可用。
          if (!isStaleRuntimeFailure(error)) throw error;
          await applyModelToRecord(model, fallbackThinking);
        }
      } else {
        await applyModelToRecord(model, fallbackThinking);
      }
      props.onClose();
    } catch (error) {
      // 模型在本地 models.json 存在但运行中 Agent 快照未加载（pi set_model 校验失败）：
      // 关闭选择器并提示用户重启 Agent 使新模型生效，而非直接报错。
      if (error instanceof SessionCommandFailure && error.needsRestart && handle) {
        offerModelRestart(handle, model);
        return;
      }
      showNotice(error instanceof Error ? error.message : String(error), 4000);
    }
  }

  /**
   * 确认后先把新模型写入会话记录，再走统一重启入口。
   * setRuntimeModel 失败时不写 catalog（避免取消后误套新模型）；
   * 重启后 applyPreferences 读 catalog 才能套上用户刚确认的模型。
   * 必须走 restartActiveAgent，才能点亮 SessionView 的重启动画。
   */
  async function confirmRestart() {
    const intent = restartIntentRef.current;
    if (!intent || restarting) return;
    confirmingRestartRef.current = true;
    setRestarting(true);
    // 先关确认框，避免 AlertDialog 关闭动画盖住 overlay。
    setRestartTarget(null);
    try {
      // 重启后 applyPreferences 会按新模型能力降级档位；这里先写记录，
      // 避免重启动画结束后记录仍停留在不支持的 xhigh/max。
      const fallbackThinking = clampedThinkingForModel({
        provider: intent.provider,
        id: intent.modelId,
      });
      const updated = await desktopApi.sessions.updateRecord(sessionId, {
        model: { provider: intent.provider, modelId: intent.modelId },
        ...(fallbackThinking ? { thinkingLevel: fallbackThinking } : {}),
      });
      upsertSession(updated);
      setModelPendingMap((prev) => ({ ...prev, [sessionId]: undefined }));
      await restartActiveAgent(intent.agentId);
    } catch (error) {
      showNotice(error instanceof Error ? error.message : String(error), 4000);
    } finally {
      confirmingRestartRef.current = false;
      restartIntentRef.current = null;
      setRestarting(false);
    }
  }

  async function pickThinking(level: string) {
    // 欢迎页/未启动 Agent（无 record）：把选择存本地偏好，点「启动 Agent」创建会话时应用。
    if (!record) {
      try {
        localStorage.setItem(WELCOME_THINKING_KEY, level);
      } catch {
        // localStorage 不可用时静默
      }
      props.onClose();
      return;
    }
    const handle = currentHandle();
    try {
      if (handle) {
        try {
          const result = requireSessionCommand(await desktopApi.sessions.setRuntimeThinking(handle, level));
          const agentState = result.value;
          // pi 会按运行中模型快照钳制档位（例如刚在配置页勾选 xhigh，但 Agent 尚未重启）：
          // 记录必须写 pi 实际接受的档位，而不是请求值，否则底栏/下次启动会显示一个未生效的档位。
          const reportedLevel = agentState.thinkingLevel;
          const effectiveLevel = reportedLevel && reportedLevel.length > 0 ? reportedLevel : level;
          upsertSession({ ...record, thinkingLevel: effectiveLevel, updatedAt: Date.now() });
          // 运行中 Agent 的模型快照可能尚未包含刚在配置页勾选的档位：pi 会钳制到支持值，
          // 此时给出与主进程模型切换一致的轻量提示，避免用户以为选择被静默吞掉。
          if (effectiveLevel !== level) {
            showNotice(
              t("app.thinkingUnsupported", { level, fallback: effectiveLevel }),
              4000,
              "info",
            );
          }
          // 生成进行中：飞行中的生成仍用旧档位，新档位下一轮才生效。
          // 记录待生效指示（issue #146：xhigh->max），由 ComposerArea 在流式结束时清除。
          if (runtime?.state?.isStreaming) {
            const from = thinkingPending?.from ?? runtime.state.thinkingLevel ?? record.thinkingLevel;
            if (from && from !== effectiveLevel) {
              setThinkingPendingMap((prev) => ({ ...prev, [sessionId]: { from, to: effectiveLevel } }));
            }
          }
          // 立即将返回的 AgentRuntimeState 合并到 runtime state atom，
          // 使底部栏的思考强度即刻刷新
          const current = store.get(sessionRuntimeByIdAtom)[sessionId];
          if (current) {
            store.set(sessionRuntimeByIdAtom, {
              ...store.get(sessionRuntimeByIdAtom),
              [sessionId]: {
                ...current,
                state: current.state
                  ? { ...current.state, ...agentState }
                  : agentState,
              },
            });
          }
        } catch (error) {
          // 与模型选择同一策略：运行时不可用时降级为写记录，启动时生效
          if (!isStaleRuntimeFailure(error)) throw error;
          const updated = await desktopApi.sessions.updateRecord(sessionId, {
            thinkingLevel: level,
          });
          upsertSession(updated);
        }
      } else {
        const updated = await desktopApi.sessions.updateRecord(sessionId, {
          thinkingLevel: level,
        });
        upsertSession(updated);
      }
      props.onClose();
    } catch (error) {
      showNotice(error instanceof Error ? error.message : String(error), 4000);
    }
  }

  async function toggleFavorite(provider: string, modelId: string) {
    const key = `${provider}/${modelId}`;
    const next = favoriteModels.includes(key)
      ? favoriteModels.filter((item) => item !== key)
      : [...favoriteModels, key];
    setFavoriteModels(next);
    try {
      await desktopApi.settings.update({ favoriteModels: next });
    } catch (error) {
      setFavoriteModels(favoriteModels);
      showNotice(error instanceof Error ? error.message : String(error), 4000);
    }
  }

  if (props.picker === "template") {
    return (
      <PromptTemplatePicker
        templates={props.templates}
        onClose={props.onClose}
        onPick={props.onInsertTemplate}
      />
    );
  }
  if (props.picker === "model") {
    const welcomeModel = readWelcomeModelPreference()?.model;
    return (
      <ModelPicker
        models={models}
        current={{
          provider: runtime?.state?.provider ?? record?.model?.provider ?? welcomeModel?.provider,
          modelId: runtime?.state?.modelId ?? record?.model?.modelId ?? welcomeModel?.modelId,
          modelName: runtime?.state?.modelName,
        }}
        onClose={props.onClose}
        onPick={(model) => void pickModel(model)}
        favoriteModels={favoriteModels}
        onToggleFavorite={(provider, modelId) => void toggleFavorite(provider, modelId)}
      />
    );
  }
  if (props.picker === "mode") {
    return (
      <ComposerModePicker
        currentMode={composerMode}
        onClose={props.onClose}
        planModeAvailable={planModeAvailable}
        onPick={(nextMode) => {
          setMode({ sessionId, mode: nextMode });
          props.onClose();
        }}
      />
    );
  }
  if (props.picker === "thinking") {
    // 用「运行中模型 → 会话记录 → 欢迎页偏好」的同一优先级解析当前模型，
    // 再按 models.json 声明的 xhigh/max 支持位过滤选项（未勾选就不出现）。
    const liveModel = currentLiveModel();
    const welcomeModel = readWelcomeModelPreference()?.model;
    const thinkingSupport = findModelThinkingSupport(
      models,
      liveModel.provider || welcomeModel?.provider,
      liveModel.modelId || welcomeModel?.modelId,
    );
    return (
      <ThinkingPicker
        current={runtime?.state?.thinkingLevel ?? record?.thinkingLevel ?? readWelcomeThinkingPreference()?.thinkingLevel}
        support={thinkingSupport}
        onClose={props.onClose}
        onPick={(level) => void pickThinking(level)}
      />
    );
  }
  return (
    <>
      {null}
      {restartTarget && (
        <ConfirmDialog
          title={t("app.modelRestartTitle")}
          message={t("app.modelRestartBody", { model: restartTarget.model })}
          confirmLabel={t("common.confirm")}
          onConfirm={() => {
            confirmingRestartRef.current = true;
            void confirmRestart();
          }}
          onCancel={() => {
            // 只关框：点确定也会先走 onOpenChange(false)→onCancel。
            // 不能在这里清 restartIntentRef，否则确认路径读到空、重启不会发生。
            setRestartTarget(null);
          }}
        />
      )}
    </>
  );
}
