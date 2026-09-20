import { useCallback, useEffect, useRef, useState } from "react";
import type { ImageContent } from "../../../shared/types";
import type { TranslationKey } from "../i18n";
import {
  dataUrlToFile,
  imageMimeTypeFromPath,
  processComposerImageFile,
} from "../utils/composerImages";
import { desktopApi } from "../desktopApi";

export type UseComposerImagePickerOptions = {
  sessionId: string;
  onAddImages: (images: ImageContent[]) => void;
  showNotice: (message: string, durationMs?: number) => void;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
};

export function useComposerImagePicker({
  sessionId,
  onAddImages,
  showNotice,
  t,
}: UseComposerImagePickerOptions) {
  const [isPicking, setIsPicking] = useState(false);
  const mountedRef = useRef(true);
  const currentSessionIdRef = useRef(sessionId);
  const opSeqRef = useRef(0);
  const pickingInFlightRef = useRef(false);

  useEffect(() => {
    currentSessionIdRef.current = sessionId;
    // 会话切换时使旧操作的操作序列失效，丢弃旧会话迟到的读取结果
    opSeqRef.current++;
    pickingInFlightRef.current = false;
    setIsPicking(false);
  }, [sessionId]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      opSeqRef.current++;
      pickingInFlightRef.current = false;
    };
  }, []);

  const pickImages = useCallback(async () => {
    if (pickingInFlightRef.current || isPicking) return;
    pickingInFlightRef.current = true;
    const opSeq = ++opSeqRef.current;
    const targetSessionId = sessionId;

    setIsPicking(true);
    try {
      let result;
      try {
        result = await desktopApi.dialog.pickImages();
      } catch (err) {
        if (mountedRef.current && currentSessionIdRef.current === targetSessionId && opSeq === opSeqRef.current) {
          showNotice(t("composer.images.pickerFailed"), 4000);
        }
        return;
      }

      if (!mountedRef.current || currentSessionIdRef.current !== targetSessionId || opSeq !== opSeqRef.current) {
        return;
      }

      if (result.kind === "cancelled") {
        return;
      }

      if (result.kind === "error") {
        if (result.code === "TOO_MANY_FILES") {
          showNotice(t("composer.images.tooManyFiles", { max: 16 }), 4000);
        } else {
          showNotice(t("composer.images.pickerFailed"), 4000);
        }
        return;
      }

      const { capabilityId, paths } = result;
      const processedBatch: ImageContent[] = [];
      let failedCount = 0;

      for (const path of paths) {
        if (!mountedRef.current || currentSessionIdRef.current !== targetSessionId) return;
        try {
          const base64Data = await desktopApi.files.readBase64External(capabilityId, path, 10 * 1024 * 1024);
          if (!base64Data || typeof base64Data !== "string") {
            failedCount++;
            continue;
          }
          const mimeType = imageMimeTypeFromPath(path);
          const fileName = path.replace(/\\/g, "/").split("/").pop() || "image";
          const file = dataUrlToFile(base64Data, mimeType, fileName);
          const imageContent = await processComposerImageFile(file);
          processedBatch.push(imageContent);
        } catch {
          failedCount++;
        }
      }

      if (!mountedRef.current || currentSessionIdRef.current !== targetSessionId || opSeq !== opSeqRef.current) {
        return;
      }

      if (failedCount > 0 && processedBatch.length === 0) {
        showNotice(t("composer.images.allFailed"), 4000);
        return;
      }

      if (processedBatch.length > 0) {
        onAddImages(processedBatch);
      }
      if (failedCount > 0) {
        showNotice(t("composer.images.partialFailed", { count: failedCount }), 4000);
      }
    } finally {
      pickingInFlightRef.current = false;
      if (mountedRef.current) {
        setIsPicking(false);
      }
    }
  }, [isPicking, onAddImages, sessionId, showNotice, t]);

  return {
    isPicking,
    pickImages,
  };
}
