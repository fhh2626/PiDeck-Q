import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import vm from "node:vm";
import ts from "typescript";

const nodeRequire = createRequire(import.meta.url);

function resolveLocalModule(fromFile, specifier) {
  const base = resolve(dirname(fromFile), specifier);
  // Locale-qualified modules such as rendererCopy.en-US still need TypeScript
  // extension resolution; only actual JS/TS suffixes are terminal paths.
  const candidates = /\.(?:[cm]?[jt]sx?)$/i.test(base)
    ? [base]
    : [
        base,
        `${base}.ts`,
        `${base}.tsx`,
        `${base}.js`,
        resolve(base, "index.ts"),
        resolve(base, "index.tsx"),
        resolve(base, "index.js"),
      ];
  const match = candidates.find(
    (candidate) => existsSync(candidate) && statSync(candidate).isFile(),
  );
  if (!match) {
    throw new Error(`Cannot resolve local test module ${specifier} from ${fromFile}`);
  }
  return match;
}

/**
 * Load the production TypeScript dependency graph in a CommonJS VM for Node tests.
 * This keeps tests independent from bundler-only extension resolution without asking
 * production imports to change solely for the test runner.
 */
export function loadTsCommonJs(filePath, options = {}) {
  const cache = new Map();
  const stubs = options.stubs ?? {};

  function load(resolvedPath) {
    const absolutePath = resolve(resolvedPath);
    if (cache.has(absolutePath)) return cache.get(absolutePath).exports;

    const output = ts.transpileModule(readFileSync(absolutePath, "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
        jsx: ts.JsxEmit.ReactJSX,
      },
      fileName: absolutePath,
    }).outputText;
    const module = { exports: {} };
    cache.set(absolutePath, module);

    const localRequire = (specifier) => {
      if (Object.hasOwn(stubs, specifier)) return stubs[specifier];
      // Shared UI primitives use the same renderer alias as the Vite build.
      if (specifier.startsWith("@/")) {
        return load(resolveLocalModule(resolve("src/renderer/src/index.ts"), `./${specifier.slice(2)}`));
      }
      if (specifier.startsWith(".") || specifier.startsWith("/")) {
        return load(resolveLocalModule(absolutePath, specifier));
      }
      return nodeRequire(specifier);
    };

    vm.runInNewContext(output, {
      module,
      exports: module.exports,
      require: localRequire,
      __filename: absolutePath,
      __dirname: dirname(absolutePath),
      console,
      process,
      Buffer,
      URL,
      URLSearchParams,
      TextDecoder,
      TextEncoder,
      AbortController,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      setImmediate,
      clearImmediate,
      queueMicrotask,
      crypto: globalThis.crypto,
      ...options.globals,
    }, { filename: absolutePath });
    return module.exports;
  }

  return load(filePath);
}
