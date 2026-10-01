# Frequently Asked Questions

## General

### What is PiDeck?

PiDeck is an open-source desktop workbench supporting the original Pi Agent and Pi_Agent_Rust across local project folders. It provides a unified interface for coding-agent sessions, Git, terminal, and configuration management.

### Is PiDeck a fork of pi?

No. PiDeck is a native Qt6/QtWebView host with a Node Sidecar that launches compatible RPC agent processes. The agent capabilities are provided by the selected runtime — PiDeck manages the project and session layer on top.

### Which platforms are supported?

The native SDK/staging pipeline is Windows-first and requires WebView2 Runtime. Check actual GitHub release files; macOS/Linux source branches do not establish verified installers.

## Usage

### Can I run multiple agents at the same time?

Yes. Each project gets its own independent RPC agent process, so you can run the original Pi Agent and Pi_Agent_Rust simultaneously for different projects.

### How do I recover a previous session?

Open the session timeline from the toolbar. You can browse past conversations by date and restore any session with full context.

### Can I import sessions from other tools?

Yes. PiDeck supports importing sessions from Claude Code and OpenAI Codex.

### How does the session reference (&) work?

Type `&` in the composer to search and reference past sessions from the same project. You can inject full session context or select specific messages.

## Technical

### What's the minimum Node.js version?

The manifest requires Node.js 24.19.0 and npm 11+. Native development also needs xmake, a C++20/MSVC toolchain and Qt 6.11.2; see [Development](/en/guide/development).

### Can I use PiDeck with self-hosted models?

Yes. In the Models settings, you can configure custom API endpoints for any compatible provider.

### Does PiDeck collect telemetry?

No. PiDeck does not collect any usage data or telemetry. All data stays on your machine.

### How do I update PiDeck?

Check GitHub Releases and follow the instructions for the actual artifact. There is no built-in application update system.

## Troubleshooting

### The agent is not responding

1. Check that your API keys are configured correctly in Settings > Auth.
2. Verify network connectivity to your model provider.
3. Try restarting the session.

### Git panel shows no changes

Make sure you have initialized a Git repository in your project folder. If the project is a Git worktree, the panel should detect it automatically.

### Terminal is not working

PiDeck tries PowerShell, cmd, and sh in order. If none are available, the terminal will show an error. Install a supported shell and restart PiDeck.

### The app won't start

- Check the log file in the app's data directory.
- Make sure no other instance is already running.
- On Windows, check that WebView2 Runtime is installed.
- Source support on other platforms is not a claim of tested installer availability.
