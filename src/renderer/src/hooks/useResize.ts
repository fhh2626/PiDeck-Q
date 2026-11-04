import { useCallback, useEffect, useRef, useState } from "react";

// Keep the default workbench geometry aligned with the main dev branch. The
// Session-first change only affects when a runtime begins, not sidebar width.
export const DEFAULT_LIST_WIDTH = 221;
/** 侧栏可调宽度下限/上限（AppShell 布局约束同源，禁止两处漂移）。 */
export const LIST_WIDTH_MIN = 100;
export const LIST_WIDTH_MAX = 440;
/** 侧栏宽度是全局布局偏好（与项目无关），不按项目拆分存储键。 */
export const LIST_WIDTH_STORAGE_KEY = "pid:list-width";

export type UseResizeOptions = {
  storage?: Pick<Storage, "getItem" | "setItem">;
};

/**
 * 读取持久化侧栏宽度：
 * - 无存储/损坏/越界一律回退默认值
 * - 强制 clamp 到 [LIST_WIDTH_MIN, LIST_WIDTH_MAX]——即使本地曾被写入 0（折叠态）
 *   或极小值，恢复后也至少是可拖拽的最小宽度，绝不出现“侧栏窄到拖不动”。
 */
export function readListWidth(storage: UseResizeOptions["storage"] | undefined): number {
  if (!storage) return DEFAULT_LIST_WIDTH;
  try {
    const raw = storage.getItem(LIST_WIDTH_STORAGE_KEY);
    if (raw === null) return DEFAULT_LIST_WIDTH;
    const width = Number(raw);
    if (!Number.isFinite(width)) return DEFAULT_LIST_WIDTH;
    return Math.min(LIST_WIDTH_MAX, Math.max(LIST_WIDTH_MIN, Math.round(width)));
  } catch {
    return DEFAULT_LIST_WIDTH;
  }
}

/** 写入持久化侧栏宽度；存储不可用时静默跳过，布局功能不受影响。 */
export function writeListWidth(storage: UseResizeOptions["storage"] | undefined, width: number) {
  try {
    storage?.setItem(LIST_WIDTH_STORAGE_KEY, String(width));
  } catch {
    // Storage is a convenience; layout must keep working when it is unavailable.
  }
}

/**
 * 侧栏宽度/折叠状态（#115 U5 起拖拽交互由 react-resizable-panels 承担，
 * 本 hook 只保留状态与折叠切换；composer 拖拽逻辑已随布局换装删除）。
 *
 * 持久化约定：
 * - 只记忆展开宽度（拖拽提交路径回写，AppShell 拖拽折叠时不会调用 setListWidth），
 *   从不记忆折叠状态——重启后侧栏总是展开，避免“上次折叠成 0 → 这次找不到侧栏”。
 * - 折叠后再展开恢复折叠前的宽度，而不是重置为默认值（重置还会把已保存的宽度覆盖掉）。
 * - 初始宽度从 localStorage 恢复（clamp 到可调范围），宽度变化即写回，无需节流。
 */
export function useResize(options: UseResizeOptions = {}) {
  const storageRef = useRef(options.storage ?? (typeof window !== "undefined" ? window.localStorage : undefined));
  storageRef.current = options.storage ?? (typeof window !== "undefined" ? window.localStorage : undefined);
  const [listWidth, setListWidth] = useState(() => readListWidth(storageRef.current));
  const [listCollapsed, setListCollapsed] = useState(false);
  useEffect(() => {
    writeListWidth(storageRef.current, listWidth);
  }, [listWidth]);

  // 折叠开关会被快捷键 / 原生菜单这类长寿命回调持有，所以读 ref 里的最新状态而不是闭包里的某次渲染值，
  // 并保持回调身份稳定（否则旧闭包第二次调用仍按“未折叠”处理，永远展不开）。
  const listWidthRef = useRef(listWidth);
  const listCollapsedRef = useRef(listCollapsed);
  listWidthRef.current = listWidth;
  listCollapsedRef.current = listCollapsed;

  const toggleListCollapsed = useCallback(() => {
    const nextCollapsed = !listCollapsedRef.current;
    // 展开时恢复折叠前的宽度（折叠态从不回写宽度，state 里仍是用户拖出来的值）；
    // 只有宽度已低于可拖拽下限这种异常值才回退默认，避免展开后卡在拖不动的窄条。
    if (!nextCollapsed && listWidthRef.current < LIST_WIDTH_MIN) setListWidth(DEFAULT_LIST_WIDTH);
    if (nextCollapsed) {
      // 收起后焦点仍可能留在侧栏中的控件上；先释放，避免隐藏内容保留键盘焦点。
      (document.activeElement as HTMLElement | null)?.blur();
    }
    // 同步更新 ref：同一事件循环里连续调用两次也要各自基于最新值翻转。
    listCollapsedRef.current = nextCollapsed;
    setListCollapsed(nextCollapsed);
  }, []);
  return {
    listWidth,
    setListWidth,
    listCollapsed,
    setListCollapsed,
    DEFAULT_LIST_WIDTH,
    toggleListCollapsed,
  };
}
