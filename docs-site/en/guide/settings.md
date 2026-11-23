# Settings & Skills

PiDeck provides visual configuration management for all its settings.

## Opening Settings

Click the gear icon in the toolbar to open the settings panel. Settings are organized into tabs:

### Models

Configure the AI models available to your agents:

- **Provider** — Select from supported providers (OpenAI, Anthropic, etc.).
- **Model** — Choose the specific model version.
- **Endpoint** — Custom API endpoint URL (for proxies or self-hosted models).
- **Parameters** — Temperature, max tokens, top-p, and other model parameters.

Configure authentication through the selected Pi runtime's login or provider setup. PiDeck-Q uses the credentials already configured in that runtime. Configuration import and export include model and settings files.

### General Settings

- **Language** — Interface language.
- **Theme** — Light, dark, or system theme.
- **Font Size** — Adjust the editor and terminal font size.
- Session persistence is owned by the selected pi runtime; PiDeck does not implement a separate Agent autosave mechanism.

## Security management

Enable security management in **Pi Manager → Security** to configure Bash and PowerShell tool actions and dangerous command patterns for each level. The PowerShell editor appears below the Bash editor. Enter one regular expression per line. These patterns apply to commands from the `powershell` tool and ignore case.

| Level | Default PowerShell rules and behavior |
| --- | --- |
| Off | The pattern list is empty and tool calls are allowed. |
| Standard | Includes patterns for file deletion and writes, process operations, Git mutations, package installation, and redirection. Commands require confirmation. |
| Strict | Uses the same dangerous command patterns. Matching commands are denied, and other commands require confirmation. |

A new custom level copies the current Standard level and can be edited independently. Clearing the PowerShell pattern list disables pattern matching while keeping the tool action in effect. Setting the tool action to Deny always blocks that tool. Setting it to Allow permits commands to run.

Saved rules take effect on the next tool call, including subagents that inherit the parent session's security policy. Older configurations receive missing PowerShell defaults while preserving existing custom patterns and explicitly empty lists.

## Skills

Skills extend the agent's capabilities. PiDeck supports two levels:

### Global Skills

Skills that apply to all projects. Managed in the main settings panel:

- Enable or disable built-in skills
- Configure skill-specific settings
- Install new skills from the skill store

### Project-Level Skills

Skills that apply only to a specific project. Accessible from the project context menu:

- Override global skill settings per project
- Enable project-specific skills
- Configure skill parameters for the project context

## Extensions

These extensions extend the pi Agent runtime; PiDeck manages their configuration and injection. Manage them in the Extensions tab:

- **Installed Extensions** — View and manage installed extensions.
- **Extension Store** — Browse and install community extensions.
- **Custom Extensions** — Load your own extensions from local files.

## Keyboard Shortcuts

| Action | Shortcut |
|--------|----------|
| Toggle sidebar | `Ctrl+B` |
| Toggle file drawer | `Ctrl+Shift+E` |
| Toggle terminal | `` Ctrl+` `` |
| Open settings | `Ctrl+,` |
| New session | `Ctrl+N` |
| Search files | `Ctrl+P` |
| Command palette | `Ctrl+Shift+P` |
