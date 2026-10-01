# Changelog

## PiDeck-Q Current Baseline

<script setup>
import { useData } from 'vitepress'
const { theme } = useData()
</script>

Current version: **{{ theme.version }}**, sourced from the root manifest. This identifies the current baseline, not a fabricated release date or a claim that planned fixes are complete. See [PiDeck-Q Releases](https://github.com/fhh2626/PiDeck-Q/releases) for actual artifacts.

## Upstream History Archive

The following 0.6.7 highlights belong to upstream [PiDeck](https://github.com/ayuayue/PiDeck), not PiDeck-Q's release line or current feature list. Repository history includes upstream documentation update `184ae39d` and upstream merge `d2a958a1`. References to pets, Electron or removed features are historical only. The [Chinese archive](/changelog) preserves the longer upstream 0.6.x/0.7.0 record.

### v0.6.7 (highlights)

- Compact titlebar + Codex-style right sidebar; file editor nested under Files
- File tree drag/drop/move; @ file tree suggestions; path chips with spaces
- Batch ask Tab UI; session message Fork; boot splash pi assembly animation
- Single-instance window reuse; startup window size presets (default maximized)
- Compaction settings UI; LaTeX/math fences; Electron Chromium sandbox toggle
- Fixes: pet stuck states (#107), titlebar sidebar toggles (#104), stop afterglow,
  built-in extension disable cleanup, manual compact state, clipboard focus

Contributors this cycle: **@1900EasonJin** (#104, #107), **@zzq168281-coder** (#103), **@me9rez** (#97), **@weishiair**, **@clancyclaw**
