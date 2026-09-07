/** Shared renderer/Node limits for the loopback native transport. */
export const MAX_NATIVE_RPC_BODY_BYTES = 32 * 1024 * 1024;
/** Leave headroom for JSON framing, text, MIME metadata, and RPC fields. */
export const MAX_COMPOSER_TOTAL_IMAGE_BASE64_BYTES = 24 * 1024 * 1024;
export const MAX_NATIVE_EVENT_FRAME_BYTES = 32 * 1024 * 1024;
