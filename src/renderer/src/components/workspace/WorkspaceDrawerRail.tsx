import type { ReactNode } from "react";
import { Button } from "../ui-shadcn/button";
import { cn } from "../../lib/utils";

/**
 * 抽屉活动栏动作项：由 App 层组装（复用与 outline 相同的打开/关闭语义），
 * rail 本体只负责渲染与激活态展示，不感知具体面板业务。
 */
export type WorkspaceDrawerRailAction = {
  id: string;
  label: string;
  icon: ReactNode;
  active: boolean;
  onClick: () => void;
};

/**
 * 右侧抽屉活动栏（#115 pure official）：横排 tab，shadcn ghost/secondary 按钮。
 * 抽屉打开期间始终可见，无活跃会话时也能切换当前可用面板。
 * 开/关抽屉按钮留在会话 Tab 栏右侧，不进本栏。
 */
export function WorkspaceDrawerRail(props: { actions: WorkspaceDrawerRailAction[] }) {
  if (props.actions.length === 0) return null;
  return (
    <div
      className="drawer-activity-rail flex h-10 shrink-0 items-center gap-1 border-b border-border/40 bg-background px-2"
      role="tablist"
      aria-orientation="horizontal"
    >
      {props.actions.map((action) => (
        <Button
          key={action.id}
          type="button"
          role="tab"
          aria-selected={action.active}
          data-testid={`drawer-rail-${action.id}`}
          variant={action.active ? "secondary" : "ghost"}
          size="icon"
          className={cn(
            "drawer-activity-rail-button relative size-8",
            action.active && "active",
          )}
          title={action.label}
          aria-label={action.label}
          onClick={action.onClick}
        >
          {action.icon}
          {action.active ? (
            <span
              className="pointer-events-none absolute inset-x-1.5 -bottom-1 h-0.5 rounded-full bg-foreground"
              aria-hidden="true"
            />
          ) : null}
        </Button>
      ))}
    </div>
  );
}
