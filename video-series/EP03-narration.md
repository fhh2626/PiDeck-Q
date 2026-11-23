上集我们安装了 PiDeck，也跑通了第一个项目。但如果你留意一下，会发现每个项目后面都有一个状态点。这背后到底发生了什么？这集我们就来搞清楚。

首先你要理解一个核心概念：PiDeck 不是原版 Pi Agent 或 Pi-Bolt 的分支，它是一个外壳。PiDeck 本身不提供 AI 能力。它做的是管理 Agent 运行时进程，然后把运行时的能力包装成图形界面。你可以把 PiDeck 想象成一个浏览器，而 Agent 运行时是背后的搜索引擎。浏览器本身不搜索，但它让搜索变得好用。

更具体地说，PiDeck 里每一个 Agent Tab，都对应一个独立的 RPC Agent 进程。这意味着项目 A 和项目 B 是完全隔离的。它们的上下文、会话历史、环境变量，全部独立。你在项目 A 里聊到一半，切换到项目 B，再切回来，项目 A 的上下文还在。这就是为什么 PiDeck 可以同时管理多个项目，而不会互相干扰。如果你想验证这一点，打开任务管理器，你会看到每个运行中的项目都对应一个 Agent 进程。

理解了架构之后，我们来看连接状态。PiDeck 左侧项目列表后面的小圆点，就是 Agent 运行时进程的连接状态。绿色代表运行中，说明进程已经启动，并且 PiDeck 成功连接上了。黄色代表启动中，Agent 正在初始化。灰色或者没有圆点，代表这个项目还没有启动 Agent。正常情况下，你点击项目后几秒钟内应该变成绿色。如果一直是黄色或者红色，说明连接有问题。

最常见的连接问题是：pi 命令不在系统的 PATH 中。这通常发生在你刚安装了 pi，但终端还没有刷新环境变量的时候。解决方法很简单。先关闭所有已经打开的终端窗口，然后重新打开一个新的终端，输入 pi --version。如果还是报错，检查一下 Node.js 的全局安装目录是否已经加入了 PATH。Windows 用户可以在 PowerShell 里输入 echo $env:PATH 查看。Mac 和 Linux 用户输入 echo $PATH。

如果你的网络环境需要走代理，你还需要配置代理设置。PiDeck 有两套代理：一套是桌面端代理，用于 PiDeck 本身的网络请求；另一套是 pi Agent 子进程代理，用于模型调用。在设置里，你可以分别配置这两个代理。如果你不确定怎么填，可以先问一下你们公司的运维，或者查看 pi 的官方文档。

配置完之后，怎么验证连接是否成功呢？很简单，在对话区随便发一条消息。如果 AI 正常回复，说明连接没问题。如果报错，先看一下错误提示。常见的错误包括 API Key 无效、模型名称错误、或者网络超时。这些问题我们会在下一集详细讲解。

好，总结一下。PiDeck 是一个外壳，每个 Agent Tab 对应一个 pi 进程。绿色状态代表连接成功，黄色代表正在启动。如果连接失败，先检查 pi 是否在 PATH 中，再检查代理设置。如果这四件事都正常，你已经在使用 PiDeck 了。

这一集到这里。下集我们讲模型配置和 API Key 管理，这是让 AI 真正跑起来的关键一步。如果这个视频对你有帮助，点个赞、投个币。有问题评论区见。我是曹阿宇，我们下集见。



Last episode we installed PiDeck and ran our first project. But if you look closely, you will notice a small status dot next to each project. What is actually happening behind the scenes? That is what we are covering in this episode.

First, you need to understand one core concept: PiDeck is not a fork of the original Pi Agent or Pi-Bolt. It is a shell. PiDeck does not provide AI capabilities itself. What it does is manage Agent runtime processes and wrap their capabilities into a graphical interface. You can think of PiDeck as a browser, and the Agent runtime as the search engine behind it. The browser does not search, but it makes searching usable.

More specifically, every Agent Tab in PiDeck corresponds to an independent pi RPC process. This means Project A and Project B are completely isolated. Their contexts, session histories, and environment variables are all separate. If you are in the middle of a conversation in Project A, switch to Project B, and then switch back, Project A's context is still there. That is why PiDeck can manage multiple projects simultaneously without them interfering with each other. If you want to verify this, open Task Manager and you will see a separate pi process for each running project.

Now let us look at the connection status. The small dot next to each project in the PiDeck sidebar represents the connection status of the Agent runtime process. Green means running, which indicates the process has started and PiDeck has successfully connected. Yellow means starting up, which means the Agent runtime is initializing. Gray or no dot means the Agent for that project has not started yet. Normally, the dot should turn green within a few seconds after you click the project. If it stays yellow or red, there is a connection issue.

The most common connection problem is that the pi command is not in your system's PATH. This usually happens right after you install pi, before your terminal has refreshed its environment variables. The fix is simple. Close all open terminal windows, open a new terminal, and type pi --version. If you still get an error, check whether Node.js's global installation directory has been added to PATH. Windows users can type echo $env:PATH in PowerShell to check. Mac and Linux users type echo $PATH.

If your network environment requires a proxy, you will also need to configure proxy settings. PiDeck has two separate proxies: one for the desktop app itself, and one for the pi Agent subprocess, which is used for model calls. You can configure both separately in the settings. If you are unsure what to enter, ask your company's IT team or check pi's official documentation.

After configuration, how do you verify the connection is working? Simply send any message in the chat area. If the AI responds normally, the connection is fine. If there is an error, read the error message first. Common errors include invalid API Key, wrong model name, or network timeout. We will cover these in detail in the next episode.

To summarize: PiDeck is a shell, and each Agent Tab corresponds to one pi process. Green means connected, yellow means starting. If the connection fails, check whether pi is in your PATH first, then check your proxy settings. If those four things are normal, you are already using PiDeck.

That is it for this episode. Next time, we cover model configuration and API Key management, which is the key step to getting AI working. If this video helped, give it a like and a coin. Questions go in the comments. This is Cao A Yu. See you next episode.
