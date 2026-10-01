# Development & Packaging

<script setup>
import { useData } from 'vitepress'
const { theme } = useData()
</script>

Current version: **{{ theme.version }}**, sourced from the root `package.json`.

## Requirements and entry points

- Node.js **24.19.0**, npm **11+**, Git and xmake.
- A C++20 toolchain; MSVC on Windows.
- Local Xmake package definitions use Qt **6.11.2** and Node runtime **24.19.0**.
- **WebView2 Runtime** is required for the Windows desktop window.
- Real Agent use requires Pi Agent or Pi_Agent_Rust plus model/auth configuration.

The native SDK and staging pipeline are Windows-first. macOS/Linux source branches do not establish verified installers for those platforms.

```bash
git clone https://github.com/fhh2626/PiDeck-Q.git
cd PiDeck-Q
npm install
npm run make-icon
npm run dev
```

`dev` builds the renderer, Sidecar and native debug target, then launches `release/win-unpacked/PiDeck-Q.exe`. It is not Electron and does not promise automatic hot reload of every process.

## Structure and transport

| Path | Responsibility |
| --- | --- |
| `native/src/main.cpp` | Qt6/QtWebView host entry |
| `src/native-node/index.ts` | Node Sidecar assembly |
| `src/main/backend/createBackend.ts` | Business service assembly |
| `src/main/backend/registerBackendRpc.ts` | Domain IPC registration |
| `src/main/` | Sessions, pi processes, Git, settings and terminals |
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
| `npm run pack` | Build and validate Windows staging |
| `npm run dist:win` | Windows staging and host RPC validation; installer compilation is currently disabled |
| `npm run test:native-host-rpc` | Native host RPC integration tests |
| `npm run test:native-gui` | Native GUI integration tests |
| `npm run docs:dev` | VitePress development server |
| `npm run docs:build` | Build docs and check internal links |
| `npm run docs:preview` | Preview generated docs |

There is no current `dist`, `dist:mac`, `dist:linux` or `preview` script. Xmake and `scripts/stage-native-runtime.mjs` stage Qt, Node, renderer, Sidecar and resources, without electron-builder/asar.

## Documentation and contributions

VitePress sources live in `docs-site/`. `VITEPRESS_BASE` controls the deployment base and `DOCS_SITE_ORIGIN` the origin; `public/CNAME` retains the custom domain.

Current-version displays follow the manifest. Upstream history is labeled separately. Contributions follow the dependency boundaries, testing gates and commit authorization rules in the root `AGENTS.md`.
