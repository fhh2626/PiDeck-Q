# Development & Packaging

<script setup>
import { useData } from 'vitepress'
const { theme } = useData()
</script>

Current version: **{{ theme.version }}**, sourced from the root `package.json`.

## Requirements and entry points

- Node.js **24.19.0**, npm **11+**, Git and xmake.
- A C++20 toolchain; MSVC on Windows.
- Local Xmake package definitions use Qt **6.11.2**. Node.js **24.19.0** is a build and test tool.
- **WebView2 Runtime** is required for the Windows desktop window.
- Real Agent use requires Pi Agent or Pi-Bolt plus model/auth configuration.

The native SDK and staging pipeline are Windows-first. macOS/Linux source branches do not establish verified installers for those platforms.

```bash
git clone https://github.com/fhh2626/PiDeck-Q.git
cd PiDeck-Q
npm install
npm run make-icon
npm run dev
```

`dev` builds the renderer, extension resources and native debug target, then launches `release/win-unpacked/PiDeck-Q.exe`. It is not Electron and does not promise automatic hot reload of every process.

## Structure and transport

| Path | Responsibility |
| --- | --- |
| `native/src/main.cpp` | Qt6/QtWebView host entry |
| `native/backend/` | Native C++ business backend (`PiDeckBackend.exe`, the packaged sidecar) |
| `src/shared/` | IPC names, types and desktop API contracts |
| `src/renderer/` | React/Jotai desktop and Web views |

Qt ↔ Sidecar uses local TCP with length-prefixed JSON. Renderer ↔ Sidecar uses loopback HTTP RPC and SSE. Only Sidecar ↔ pi uses stdio JSONL RPC. There is no current preload/WebChannel entry.

## Available commands

| Command | Description |
| --- | --- |
| `npm run dev` | Native Windows debug build and launch |
| `npm run typecheck` | TypeScript and browser-test type checks |
| `npm test` | All unit tests using substitutes, not real pi |
| `npm run test:browser` | Playwright regression tests |
| `npm run build` | Type check and build renderer/Sidecar |
| `npm run build:native` | Xmake native build |
| `npm run pack` | Build and validate Windows staging (`release/win-unpacked`; set `PIDECK_STAGE_DIR` to stage somewhere else, e.g. a measurement directory) |
| `npm run dist:win` | Windows staging and host RPC validation; installer compilation is currently disabled |
| `npm run test:native-host-rpc` | Native host RPC integration tests |
| `npm run test:native-gui` | Native GUI integration tests |
| `npm run docs:dev` | VitePress development server |
| `npm run docs:build` | Build docs and check internal links |
| `npm run docs:preview` | Preview generated docs |

Xmake and `scripts/stage-extension-dependencies.mjs` stage Qt, the renderer, extension resources and the C++ backend. `npm run pack` and `scripts/verify-pack-stage.mjs` share `PIDECK_STAGE_DIR`, which defaults to `release/win-unpacked`. The package contains no Node business backend or bundled Node interpreter.

## Publish a Windows ZIP with GitHub Actions

Once the workflow is on the default branch (`main`), open **Actions → Release Windows ZIP → Run workflow**. Build a preview on `main` or on `native2` if it contains the workflow. By default, the ZIP appears under the run's Artifacts without creating a tag or release. Publishing is restricted to `main`. Before publishing, download a preview built from `main`, extract it on Windows, and run `PiDeck-Q.exe`. Then select `main`, enable `publish`, enter `release_notes`, and enable `prerelease` if appropriate.

The workflow runs `npm test`, then `npm run pack`. It takes the version from `package.json` at the selected commit. If the version is already taken by a tag or release, the workflow adds the next rebuild number, for example `0.5.1.1` after `0.5.1`. The suffix applies to the tag, ZIP name, and native build version for that run. It does not modify the committed manifest or lockfile. The asset follows the existing `PiDeck-Q-<version>-win.zip` format and is ready to run after extraction.

The publish job tags the tested commit and makes the release public only after the ZIP is attached. If publishing fails after the tag is created, any tag or draft already created is left in place. Inspect and finish the draft, or rerun the workflow to use the next rebuild number.

## Pi regular expression compatibility

PiDeck supports Pi Agent running on Node.js 22.19.0 or later. Run the full test suite on the repository's Node.js 24.19.0. When changing the security regex validator or upgrading `regexpp`, install dependencies with Node 24, then run these targeted checks with Node 22.19.0:

```bash
node scripts/security-regex-validator/generate-unicode16.mjs --check
node --test tests/securityRegexValidatorBundle.test.mjs
```

The tests use Node 22's native regex engine to check Unicode 16 group names. After changing the shared validator or `regexpp`, run `npm run build:security-regex-validator` with Node 24 to regenerate the embedded C++ resource.

## Documentation and contributions

VitePress sources live in `docs-site/`. `VITEPRESS_BASE` controls the deployment base and `DOCS_SITE_ORIGIN` the origin; `public/CNAME` retains the custom domain.

Current-version displays follow the manifest. Upstream history is labeled separately. Contributions follow the dependency boundaries, testing gates and commit authorization rules in the root `AGENTS.md`.
