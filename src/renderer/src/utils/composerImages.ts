import type { ImageContent } from "../../../shared/types";
import { MAX_COMPOSER_TOTAL_IMAGE_BASE64_BYTES } from "../../../shared/desktop/nativeLimits.ts";

export const COMPOSER_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const COMPOSER_TOTAL_IMAGE_BASE64_MAX_BYTES = MAX_COMPOSER_TOTAL_IMAGE_BASE64_BYTES;
export const COMPOSER_IMAGE_MAX_EDGE = 2000;
export const COMPOSER_IMAGE_QUALITY = 0.86;
export const COMPOSER_IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

export type ComposerImageErrorCode = "too-large" | "unsupported" | "read-failed" | "decode-failed";

export class ComposerImageError extends Error {
  readonly code: ComposerImageErrorCode;

  constructor(code: ComposerImageErrorCode, message: string) {
    super(message);
    this.name = "ComposerImageError";
    this.code = code;
  }
}

export function composerImageBase64Bytes(images: ImageContent[] | undefined): number {
  return images?.reduce((total, image) => total + image.data.length, 0) ?? 0;
}

export function exceedsComposerImagePayloadBudget(images: ImageContent[] | undefined): boolean {
  return composerImageBase64Bytes(images) > COMPOSER_TOTAL_IMAGE_BASE64_MAX_BYTES;
}

export function dataUrlToImageContent(
  dataUrl: string,
  fallbackMimeType: string,
): ImageContent {
  const comma = dataUrl.indexOf(",");
  const meta = comma >= 0 ? dataUrl.slice(0, comma) : "";
  const data = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  const mimeType = meta.match(/^data:(.*?);base64$/)?.[1] || fallbackMimeType;
  return { type: "image", data, mimeType };
}

export function getClipboardImageFiles(data: DataTransfer): File[] {
  return Array.from(data.items)
    .filter((item) => item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file));
}

/** 粘贴/附件场景支持的图片扩展名（与 COMPOSER_IMAGE_MIME_TYPES 对齐，bmp 不支持故排除） */
const IMAGE_PATH_RE = /\.(png|jpe?g|gif|webp)$/i;

/** 判断本地路径是否为受支持的图片文件（大小写不敏感，允许带空格/多段扩展名） */
export function isImageFilePath(path: string): boolean {
  return IMAGE_PATH_RE.test(path);
}

/** 按扩展名推导图片 MIME（未知扩展名默认 image/png） */
export function imageMimeTypeFromPath(path: string): string {
  const ext = (path.match(/\.([^.]+)$/)?.[1] ?? "").toLowerCase();
  switch (ext) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    default:
      return "image/png";
  }
}

/** dataURL → File（粘贴资源管理器图片文件时，把主进程读回的原图字节包装成 File 走统一附件流程） */
export function dataUrlToFile(dataUrl: string, mimeType: string, fileName: string): File {
  const comma = dataUrl.indexOf(",");
  const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new File([bytes], fileName, { type: mimeType });
}

export function getDroppedImageFiles(data: DataTransfer): File[] {
  return Array.from(data.files).filter((file) => file.type.startsWith("image/"));
}

/** 校验图片文件是否可被解码，防止伪装或损坏的图片文件流入。验证完毕后立即释放 ObjectURL。 */
export function verifyImageDecodable(file: File): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof Image === "undefined" || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
      // 处于无 DOM 环境（如纯 node 单元测试环境）时跳过浏览器解码检查
      resolve();
      return;
    }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve();
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new ComposerImageError("decode-failed", "Failed to decode image file"));
    };
    img.src = url;
  });
}

export async function processComposerImageFile(file: File): Promise<ImageContent> {
  if (file.size > COMPOSER_IMAGE_MAX_BYTES) {
    throw new ComposerImageError("too-large", "Image exceeds the composer size limit");
  }
  if (!COMPOSER_IMAGE_MIME_TYPES.has(file.type)) {
    throw new ComposerImageError("unsupported", "Unsupported composer image type");
  }
  // 先验证图片能否正常解码；伪造格式或损坏图片在此处直接拒绝
  await verifyImageDecodable(file);

  // GIF 格式保留全部原始帧字节，不强制转换为静态 PNG/JPEG
  if (file.type === "image/gif") return fileToImageContent(file);

  try {
    return await resizeImageFile(
      file,
      COMPOSER_IMAGE_MAX_EDGE,
      COMPOSER_IMAGE_QUALITY,
    );
  } catch {
    return fileToImageContent(file);
  }
}

export function fileToImageContent(file: File): Promise<ImageContent> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(
      new ComposerImageError("read-failed", reader.error?.message ?? "Image read failed"),
    );
    reader.onload = () => resolve(
      dataUrlToImageContent(String(reader.result), file.type),
    );
    reader.readAsDataURL(file);
  });
}

export function resizeImageFile(
  file: File,
  maxEdge: number,
  quality: number,
): Promise<ImageContent> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const image = new Image();
      image.onerror = reject;
      image.onload = () => {
        const scale = Math.min(1, maxEdge / Math.max(image.width, image.height));
        const width = Math.max(1, Math.round(image.width * scale));
        const height = Math.max(1, Math.round(image.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");
        if (!context) {
          reject(new Error("Canvas 2D context is unavailable"));
          return;
        }
        context.drawImage(image, 0, 0, width, height);
        const outputType = file.type === "image/png" ? "image/png" : "image/jpeg";
        resolve(dataUrlToImageContent(canvas.toDataURL(outputType, quality), outputType));
      };
      image.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}
