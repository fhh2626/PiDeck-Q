import { useEffect, useRef } from "react";
import { useStore } from "jotai";
import type {
  AppFocusSessionTarget,
  AppSettings,
  AppUpdateDownloadProgress,
  Project,
} from "../../../shared/types";
import { replaceProjectInventoryAtom } from "../atoms";
import { desktopApi } from "../desktopApi";
import {
  invalidateProjectInventoryRequests,
  requestProjectInventory,
} from "../utils/projectInventoryRequests";

type GlobalAgentListenerCallbacks = {
  onProjectsChanged?: (projects: Project[]) => void;
  onFocusTarget?: (target: AppFocusSessionTarget) => void;
  onSettingsApplied?: (settings: AppSettings) => void;
  onUpdateProgress?: (progress: AppUpdateDownloadProgress) => void;
  onTrustRequest?: (request: {
    requestId: string;
    cwd: string;
    projectName: string;
  }) => void;
};

export function useGlobalAgentListeners(
  callbacks: GlobalAgentListenerCallbacks = {},
): void {
  const store = useStore();
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  useEffect(() => {
    let disposed = false;

    void requestProjectInventory(desktopApi.projects.list).then((projects) => {
      if (disposed || !projects) return;
      store.set(replaceProjectInventoryAtom, projects);
      callbacksRef.current.onProjectsChanged?.(projects);
    }).catch(() => undefined);
    const offProjects = desktopApi.projects.onChanged((projects) => {
      // Push snapshots are authoritative and must invalidate every older list()
      // response before replacing the inventory.
      invalidateProjectInventoryRequests();
      store.set(replaceProjectInventoryAtom, projects);
      callbacksRef.current.onProjectsChanged?.(projects);
    });
    const offFocusTarget = desktopApi.app.onFocusSessionTarget((target) => {
      callbacksRef.current.onFocusTarget?.(target);
    });
    const offSettings = desktopApi.settings.onApplyWindow((settings) => {
      callbacksRef.current.onSettingsApplied?.(settings);
    });
    const offUpdateProgress = desktopApi.app.onUpdateProgress((progress) => {
      callbacksRef.current.onUpdateProgress?.(progress);
    });
    const offTrustRequest = desktopApi.projects.onTrustRequest((request) => {
      callbacksRef.current.onTrustRequest?.(request);
    });

    return () => {
      disposed = true;
      offProjects();
      offFocusTarget();
      offSettings();
      offUpdateProgress();
      offTrustRequest();
    };
  }, [store]);
}
