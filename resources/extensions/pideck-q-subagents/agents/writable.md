---
name: writable
description: Default subagent. Inherits the parent session's tools and can edit files and run shell commands.
tools: parent
hostShell: true
systemPromptMode: append
inheritProjectContext: true
inheritSkills: false
defaultContext: fork
---
