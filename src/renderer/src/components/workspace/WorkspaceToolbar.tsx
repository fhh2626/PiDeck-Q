import { Maximize2, PanelLeft, PanelRight } from "lucide-react";
import type { ReactNode } from "react";
import { t } from "../../i18n";
import { cn } from "../../lib/utils";
import { Button } from "../ui-shadcn/button";

/** Window chrome controls shared by the conversation and file surfaces. */
export function WorkspaceToolbar(props: {
  listCollapsed: boolean;
  onToggleListCollapsed: () => void;
  drawerOpen: boolean;
  onToggleDrawer: () => void;
  onExitAllSplit?: () => void;
  /** Focused session identity and branch controls occupy the former tab slot. */
  sessionIdentity?: ReactNode;
}) {
  return (
    <div className="workspace-toolbar flex h-10 shrink-0 items-center gap-1 overflow-hidden border-b border-border/40 bg-background/80 pl-[max(0.5rem,var(--workspace-toolbar-left-inset,0.5rem))]">
      {props.listCollapsed && (
        <Button type="button" variant="ghost" size="icon-sm" className="list-toggle-native size-7 shrink-0"
          aria-label={t("app.expandList")} title={t("app.expandList")} onClick={props.onToggleListCollapsed}>
          <PanelLeft className="size-3.5" aria-hidden="true" />
        </Button>
      )}
      <div className="flex min-w-0 flex-1 items-center px-1">{props.sessionIdentity}</div>
      {props.onExitAllSplit && (
        <Button type="button" variant="ghost" size="icon-sm" className="size-7 shrink-0"
          aria-label={t("session.split.exitAll")} title={t("session.split.exitAll")} onClick={props.onExitAllSplit}>
          <Maximize2 className="size-3.5" aria-hidden="true" />
        </Button>
      )}
      <Button type="button" variant="ghost" size="icon-sm"
        className={cn("header-drawer-toggle size-7 shrink-0", props.drawerOpen && "active")}
        aria-label={t(props.drawerOpen ? "app.collapseDrawer" : "app.expandDrawer")}
        title={t(props.drawerOpen ? "app.collapseDrawer" : "app.expandDrawer")}
        aria-expanded={props.drawerOpen} onClick={props.onToggleDrawer}>
        <PanelRight className="size-3.5" aria-hidden="true" />
      </Button>
    </div>
  );
}
