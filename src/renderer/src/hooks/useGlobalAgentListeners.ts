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

    void desktopApi.projects.list().then((projects) => {
      if (disposed) return;
      store.set(replaceProjectInventoryAtom, projects);
      callbacksRef.current.onProjectsChanged?.(projects);
    }).catch(() => undefined);
    const offProjects = desktopApi.projects.onChanged((projects) => {
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
