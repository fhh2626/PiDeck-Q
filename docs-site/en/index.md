---
layout: home

hero:
  name: PiDeck-Q
  text: Desktop Workbench for Pi Agent and Pi_Agent_Rust
  tagline: Manage Pi Agent and Pi_Agent_Rust sessions, configs, Git and terminals in a native Qt workspace. The current build pipeline is Windows-first; other platform artifacts depend on actual releases.
  actions:
    - theme: brand
      text: Download Latest
      link: https://github.com/fhh2626/PiDeck-Q/releases
    - theme: alt
      text: Get Started
      link: /en/guide/getting-started
    - theme: alt
      text: View on GitHub
      link: https://github.com/fhh2626/PiDeck-Q

features:
  - title: Multi-Project Workspace
    details: Add, search, drag-sort, and switch local project folders. Run the original Pi Agent and Pi_Agent_Rust simultaneously with per-project isolation.
  - title: Session History & Restore
    details: Restore previous conversations, browse tool calls and answers by timeline, and review file changes in past sessions. Import Codex and Claude sessions.
  - title: Git Integration
    details: Real-time branch display, VS Code-style 3-panel view (Changes/History/Compare), AI commit summaries, branch graph, cherry-pick/revert/reset/drop, and worktree support.
  - title: Session Reference (&)
    details: Type & in composer to search and reference past sessions across the same project. Inject full context or select specific messages.
  - title: Message Queue
    details: Queue prompts while agent is busy. Retract queued messages back to input for editing. Follow-up and steer modes.
  - title: Multi-Tab File Editor
    details: Multi-tab file editing, diff comparison and Markdown preview.
  - title: Desktop Tools
    details: Scratch pad, external editor integration and terminal access. External links open in the system browser.
  - title: Built-in Terminal Dock
    details: Agent-scoped terminal tabs with PowerShell/cmd/sh fallback, multiple tabs, theme switching, height resizing, and right-click copy.
  - title: Native Build
    details: Qt6/QtWebView and a Node Sidecar. Check actual GitHub release files; ordinary browser UI preview is available for development.
---

<script setup>
import { useData } from 'vitepress'
const { theme } = useData()
</script>

Current version: **{{ theme.version }}**. PiDeck-Q is based on upstream [PiDeck](https://github.com/ayuayue/PiDeck). It uses a Qt6/QtWebView host and a Node Sidecar, not Electron. Agent behavior remains in the selected runtime. See [Changelog](/en/changelog) for separately labeled upstream history.

<figure class="home-showcase">
  <img src="/images/overview.png" alt="PiDeck workspace and conversation UI">
  <figcaption>Workspace, sessions, file drawer, Git branches, and tool calls — all in one desktop window.</figcaption>
</figure>

- **Multi-Project Workspace** — Add, search, drag-sort, and switch local project folders. Run the original Pi Agent and Pi_Agent_Rust simultaneously with per-project isolation.
- **Session History & Restore** — Restore previous conversations, browse tool calls and answers by timeline, and review file changes in past sessions. Import local Codex and Claude sessions.
- **Git Integration** — Real-time branch display and switching, VS Code-style 3-panel view (Changes/History/Compare), AI commit message generation, branch graph visualization, cherry-pick/revert/reset/drop, file tree with Git status, worktree support.
- **Session Reference (&)** — Type & in composer to search and reference past sessions across the same project. Inject full context or select specific messages.
- **Message Queue** — Queue prompts while agent is busy. Retract queued messages back to input for editing. Follow-up and steer modes.
- **Multi-Tab File Editor** — File editing, diffs and Markdown preview.
- **Floating Action Bar** — Access Terminal, Files, Git, Scratch Pad and External Editor.
- **Built-in Terminal Dock** — Agent-scoped terminal tabs with PowerShell/cmd/sh fallback, multiple tabs, theme switching, height resizing, and right-click copy.
- **Visual Config Management** — Graphical editors for Models, Auth, and Settings. Global and project-level Skills and Extension management.
- **Context-Aware Input** — `@` file suggestions, `!` shell execution, `/` slash commands, and command history in a single composer.
- **Web Access** — A separate LAN Web frontend can be enabled in settings; it is not an embedded browser panel.
- **Downloads** — Check actual GitHub release files and instructions. No built-in application updater is provided.
