// Stable PiDeck-Q built-in entrypoint for webfetch.
// 普通 WebFetch npm dependencies 必须 bundle 到 dist/index.mjs，
// 避免 packaged extension 依赖仓库根 node_modules。
export { default } from "./pideck-q-webfetch/dist/index.mjs";
