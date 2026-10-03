import { createRequire, findPackageJSON } from "node:module";
import { pathToFileURL } from "node:url";

/** Resolve compatibility dependencies from the installed Pi fixture, regardless of npm hoisting. */
export async function loadPiCompatibilityModules(piEntryUrl = import.meta.resolve("@earendil-works/pi-coding-agent")) {
  const piRequire = createRequire(piEntryUrl);
  const piAiPackage = findPackageJSON("@earendil-works/pi-ai", piEntryUrl);
  if (!piAiPackage) throw new Error("Installed Pi fixture is missing its pi-ai dependency");
  const [typebox, sampling, extensions] = await Promise.all([
    import(pathToFileURL(piRequire.resolve("typebox/value")).href),
    // Retain the real API used by the contract tests; only dependency location resolution changes.
    import(new URL("dist/api/constrained-sampling.js", pathToFileURL(piAiPackage)).href),
    import(new URL("core/extensions/loader.js", piEntryUrl).href),
  ]);
  return {
    Value: typebox.Value,
    makeStrictJsonSchema: sampling.makeStrictJsonSchema,
    loadExtensions: extensions.loadExtensions,
  };
}
