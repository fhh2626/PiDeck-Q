// 测试专用入口：让控制器与 atoms 通过 loadTsCommonJs 的同一份模块缓存加载，
// 保证测试里 seed/读取的 atom 与被测 hook 订阅的是同一个实例。
export * from "../../src/renderer/src/hooks/useSessionComposerController";
export * as atoms from "../../src/renderer/src/atoms";