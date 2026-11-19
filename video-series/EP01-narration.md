如果你已经在用 pi、Cursor 或者 Claude Code 写代码，
你一定会遇到一个问题——切换项目、管理会话、回看历史，全靠命令行，非常痛苦。
今天我要介绍的工具，叫 PiDeck。

先问一个问题。你平时有几个正在开发的项目？
一个？两个？五个？
如果超过一个，你就一定有这些烦恼：
每个项目要开一个终端窗口，每个终端里的 AI 对话是独立的，
你想回看上周写过的方案，却发现那个终端已经关了。
更别说 Git 状态、文件浏览、模型切换，全都要在终端里敲命令。

PiDeck 是一个桌面工作台，同时支持原版 Pi Agent 和 Pi-Bolt，专门用来管理你的编码 Agent 会话。
简单说，它在 pi 前面套了一个 Electron 壳，但你完全不需要管底层发生了什么。
你只需要理解一件事：
PiDeck 等于一个统一的地方，管理你所有项目的 AI 对话。

左侧是你的项目列表，中间是对话区，右侧是文件树和会话历史。
最重要的是，每个项目完全隔离。
项目 A 的上下文不会污染项目 B。
你可以在多个项目之间自由切换，每个项目里的 AI 都记得你上次聊到哪。

PiDeck 支持多项目工作区、对话与上下文管理、
Git 集成、内置终端、配置图形编辑器、以及中文提示词精选库。
内置的 Prompt 商店有 4000 多中文提示词，一键就能导入。

简单总结一下。裸 pi CLI 的能力，PiDeck 全部保留。
PiDeck 加的是图形化、多项目管理、会话可视化和 Git 集成。
你可以把 PiDeck 理解为 pi 的 GUI 层。
它不会限制你使用 pi 的任何功能。

那 PiDeck 适合谁呢？
第一，如果你已经用 pi CLI 但觉得终端管理太麻烦，你是目标用户。
第二，如果你之前用 Cursor 或 Windsurf，想找更轻量灵活的方案，PiDeck 值得试试。
第三，如果你是团队开发，多项目切换是常态，PiDeck 的多项目隔离会省很多心。
第四，如果你还在观望 AI 编程工具，PiDeck 是很好的起点，因为它免费开源，没有厂商锁定。

好，这一集到这里。
下一集，我们直接上手——从下载安装到第一次启动，一步一步带你跑通。
如果这个视频对你有帮助，点个赞、投个币，这是对我最大的支持。
有问题评论区见。我是曹阿宇，我们下集见。



If you've been using pi, Cursor, or Claude Code to write code,
you've definitely run into this problem:
switching between projects, managing sessions, reviewing past conversations —
it's all done through the command line, and it's painful.
Today I want to introduce a tool called PiDeck.

Let me ask you a question first.
How many projects are you working on right now?
One? Two? Five?
If it's more than one, you've definitely experienced these frustrations:
each project needs its own terminal window,
each terminal has its own isolated AI conversation,
and when you try to review a plan from last week,
that terminal is already closed.
Not to mention Git status, file browsing, and model switching —
it's all command line, all the time.

PiDeck is a desktop workbench supporting both the original Pi Agent and Pi-Bolt, designed to manage your coding-agent sessions.
Simply put, it wraps the selected Agent runtime in an Electron shell,
but you don't need to worry about what's happening underneath.
Here's all you need to understand:
PiDeck equals one unified place to manage AI conversations across all your projects.

On the left is your project list, in the middle is the chat area,
and on the right is the file tree and session history.
Most importantly, each project is fully isolated.
Project A's context never leaks into Project B.
You can freely switch between projects,
and the AI in each project remembers where you left off.

PiDeck supports multi-project workspaces, conversation and context management,
Git integration, a built-in terminal, a visual configuration editor,
and a curated library of Chinese prompts.
The built-in Prompt Store has over 4,000 Chinese prompts ready to import with one click.

To summarize: everything you can do with the raw pi CLI,
you can still do with PiDeck.
PiDeck adds a GUI, multi-project management, visual session history, and Git integration.
You can think of PiDeck as the GUI layer on top of pi.
It doesn't restrict any of pi's native capabilities.

So who is PiDeck for?
First, if you're already using the pi CLI but find terminal management tedious, you're the target user.
Second, if you've used Cursor or Windsurf and want something lighter and more flexible, PiDeck is worth trying.
Third, if you're a team developer switching between projects frequently, PiDeck's project isolation will save you a lot of trouble.
Fourth, if you're still evaluating AI coding tools, PiDeck is a great starting point —
it's free, open source, and has no vendor lock-in.

That's it for this episode.
Next time, we'll get our hands dirty — from download and installation to first launch, step by step.
If this video was helpful, give it a like and a coin — that's the best support you can give me.
See you in the comments if you have questions.
This is Cao A Yu. See you in the next episode.
