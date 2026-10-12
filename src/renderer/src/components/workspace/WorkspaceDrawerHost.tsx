import { ChevronLeft } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { t } from "../../i18n";
import { Button } from "../ui-shadcn/button";
import {
  DRAWER_ANIMATION_MS,
  type WorkspaceDrawerPanel,
} from "../../hooks/useWorkspacePanels";

export function getVisibleDrawerPanel<T>(
  open: boolean,
  panel: T | null,
  renderedDrawer: T | null,
) {
  return open ? panel : renderedDrawer;
}

export type WorkspaceDrawerHostProps = {
  panel: WorkspaceDrawerPanel | null;
  collapsed: boolean;
  pinned?: boolean;
  className?: string;
  style?: CSSProperties;
  onCollapse?: () => void;
  onClose?: () => void;
  onRestore?: () => void;
  onTogglePin?: () => void;
  /** 抽屉打开期间常驻的活动栏（面板切换入口），由 App 层组装后注入。 */
  rail?: ReactNode;
  renderPanel: (panel: WorkspaceDrawerPanel) => ReactNode;
};

/**
 * Keeps the drawer compositor mounted while the grid column closes. The 120ms
 * delay is part of the layout contract: removing content before the grid motion
 * completes makes text disappear before the drawer itself reaches zero width.
 */
export function WorkspaceDrawerHost(props: WorkspaceDrawerHostProps) {
  const [renderedDrawer, setRenderedDrawer] = useState<WorkspaceDrawerPanel | null>(props.panel);
  const unmountTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (unmountTimerRef.current) {
      clearTimeout(unmountTimerRef.current);
      unmountTimerRef.current = null;
    }
    if (props.panel && !props.collapsed) {
      setRenderedDrawer(props.panel);
      return;
    }
    if (!renderedDrawer) return;
    unmountTimerRef.current = setTimeout(() => {
      setRenderedDrawer(null);
      unmountTimerRef.current = null;
    }, DRAWER_ANIMATION_MS);
    return () => {
      if (unmountTimerRef.current) {
        clearTimeout(unmountTimerRef.current);
        unmountTimerRef.current = null;
      }
    };
  }, [props.collapsed, props.panel, renderedDrawer]);

  useEffect(() => () => {
    if (unmountTimerRef.current) clearTimeout(unmountTimerRef.current);
  }, []);

  const open = Boolean(props.panel && !props.collapsed);
  // A newly opened or switched panel must render synchronously; only a closing
  // compositor uses the previous rendered panel as its delayed fallback.
  const visiblePanel = getVisibleDrawerPanel(open, props.panel, renderedDrawer);
  const rendered = visiblePanel ? props.renderPanel(visiblePanel) : null;
  return (
    <>
      <aside
        className={props.className ?? "detail-drawer flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background"}
        data-open={open}
        data-rendered={Boolean(visiblePanel)}
        data-pinned={Boolean(props.pinned)}
        style={props.style}
      >
        {visiblePanel && (
          <div
            className={
              open && props.rail
                ? "drawer-content-frame drawer-content-frame--with-rail flex min-h-0 flex-1 flex-col overflow-hidden"
                : "drawer-content-frame flex min-h-0 flex-1 flex-col overflow-hidden"
            }
          >
            {open && props.rail}
            {rendered}
          </div>
        )}
      </aside>
      {props.panel && props.collapsed && props.onRestore && (
        <Button
          type="button"
          variant="outline" size="icon" className="drawer-restore inline-flex size-8 items-center justify-center rounded-md border border-border bg-background text-muted-foreground shadow-sm hover:bg-accent hover:text-accent-foreground"
          title={t("drawer.expandPanel")}
          aria-label={t("drawer.expandPanel")}
          onClick={props.onRestore}
        >
          <ChevronLeft size={16} />
        </Button>
      )}
    </>
  );
}

export { DRAWER_ANIMATION_MS };
