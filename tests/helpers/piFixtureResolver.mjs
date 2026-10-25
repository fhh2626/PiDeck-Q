/**
 * Resolve Pi-hosted packages for tests that load real subagent sources.
 *
 * Pi supplies `typebox`, `yaml` and `@earendil-works/*` to extensions at runtime;
 * the application's locked dependency graph intentionally does not. The latest-Pi
 * fixture is the only place these packages are installed, so source-loading tests
 * must opt into it explicitly instead of relying on root node_modules drift.
 *
 * Importing this module installs the hook for this repository. Import it first and
 * load extension sources with dynamic `import()`: static imports are linked before
 * the hook could be registered.
 */
import { registerHooks } from "node:module";
import { claimExtensionModuleHook } from "./extensionModuleHookClaim.mjs";
import { createPiFixtureResolveHook } from "./piFixtureResolveHook.mjs";

// Fails if the subagent graph stub loader already owns extension import rewriting.
claimExtensionModuleHook("pi-fixture-resolver");
registerHooks({ resolve: createPiFixtureResolveHook() });
