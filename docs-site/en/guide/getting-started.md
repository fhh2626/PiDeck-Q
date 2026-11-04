# Quick Start

<script setup>
import { useData } from 'vitepress'
const { theme } = useData()
</script>

Current PiDeck-Q version: **{{ theme.version }}**.

PiDeck-Q supports [Pi Agent](https://pi.dev), [Pi_Agent_Rust](https://github.com/Dicklesworthstone/pi_agent_rust) and [Pi-Bolt](https://github.com/opensec-git/Pi-Bolt) (a precompiled distribution of Pi). The desktop manages windows, projects and sessions; the runtime supplies Agent behavior.

## Download & Install

Check [GitHub Releases](https://github.com/fhh2626/PiDeck-Q/releases) for actual files and platform instructions. Do not assume every release has an installer or artifacts for every platform. The current staging pipeline is Windows-first and installer compilation is disabled.

Windows desktop use requires WebView2 Runtime. macOS/Linux source branches do not establish verified installers.

Install Pi Agent, Pi_Agent_Rust or Pi-Bolt using its official instructions, and configure providers/auth. Verify the selected command (Rust may use `pi-rust`; Pi-Bolt uses `pi-bolt`). Auto mode does not automatically discover the `pi-bolt` command (a custom Pi path can still point to it): select it under Settings → Developer → Pi Runtime Preference and set the Pi-Bolt runtime path if needed:

```bash
pi --version
```

The app detects Agent paths at startup. If detection fails, enter the selected runtime's executable path in settings.

## Run from Source

Requires Node.js **24.19.0**, npm **11+**, Git, xmake and a C++20/MSVC toolchain. Local Xmake package definitions provide Qt **6.11.2**. See [Development](/en/guide/development).

```bash
git clone https://github.com/fhh2626/PiDeck-Q.git
cd PiDeck-Q
npm install
npm run make-icon
npm run dev
```

The current `dev` workflow targets the Windows native desktop, not Electron.

## Basic Workflow

1. Add a local project directory.
2. Create a session and choose a model/thinking level.
3. Send a task, optionally using `/`, `@` and `!` input helpers.
4. Browse history, files, Git and the terminal.

## Ordinary Browser UI Preview

```bash
npm run test:browser:server
```

This is the browser test/UI preview server, not an embedded browser panel. Mock APIs do not validate real Agent, filesystem or host capabilities; test those in the native host.

The LAN Web frontend is a separate capability enabled in Web service settings, not a browser inside the desktop. It uses an authentication token and is disabled by default. Do not expose it unprotected to the public internet.
