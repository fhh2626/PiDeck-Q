/** Pi implementation selected by PiDeck. */
export type PiRuntimeKind = "typescript" | "bolt" | "unknown";

/** User preference for selecting an installed Pi implementation. */
export type PiRuntimePreference = "auto" | "typescript" | "bolt";

/**
 * Environment variable PiDeck sets on a Pi process that is a self-contained
 * binary (no Node + CLI script pair). Built-in extensions read it instead of
 * guessing from the executable name, which differs per distribution
 * (`pi`, `pi-bolt`, a macOS launcher that execs `pi-bin`, a renamed copy, ...).
 */
export const PIDECK_PI_STANDALONE_ENV = "PIDECK_PI_STANDALONE";
