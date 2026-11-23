#include "MainCopy.h"

#include <QHash>
#include <QJsonObject>
#include <QLocale>
#include <QRegularExpression>
#include <QStringList>
#include <QVector>

namespace maincopy {
namespace {

using Table = QHash<QString, QString>;

const Table &zhCN()
{
    static const Table table{
        {QStringLiteral("app.modelSelectionRequired"), QStringLiteral("当前模型已被删除，请选择新模型后再继续。")},
        {QStringLiteral("app.visionModelSelectionRequired"), QStringLiteral("视觉桥的模型未配置或已被删除，请在设置中选择新模型后再发送图片。")},
        {QStringLiteral("subagents.modelRequired"), QStringLiteral("请先选择一个模型，再保存。")},
        {QStringLiteral("mainFile.unsupportedMoveType"), QStringLiteral("此文件类型不支持移动，源文件已保留。")},
        {QStringLiteral("mainFile.unsupportedCopyType"), QStringLiteral("此文件类型不支持复制。")},
        {QStringLiteral("mainFile.renameTargetExists"),
         QStringLiteral("已存在同名文件或文件夹，未进行重命名。")},
        {QStringLiteral("git.commitMessageModelRequired"),
         QStringLiteral("未配置提交摘要生成模型，请前往 设置 > Git 配置供应商与模型后重试。")},
        {QStringLiteral("git.commitMessageBusy"), QStringLiteral("上一份提交摘要仍在生成中，请稍候再试。")},
        {QStringLiteral("git.commitMessageTimeout"), QStringLiteral("提交摘要生成超时，请重试。")},
        {QStringLiteral("mainPi.pathRequired"), QStringLiteral("请输入 pi.cmd 或 pi 路径。")},
        {QStringLiteral("mainPi.invalidWslUrl"), QStringLiteral("WSL pi 路径无效。")},
        {QStringLiteral("mainPi.powershellUnsupported"),
         QStringLiteral("暂不支持 PowerShell 的 pi.ps1，请使用 CMD 的 where pi 查到的 pi.cmd 或 pi.exe "
                        "路径。")},
        {QStringLiteral("mainPi.checkFailed"),
         QStringLiteral("无法运行 pi CLI，请检查路径和安装状态。")},
        {QStringLiteral("wsl.windowsOnly"), QStringLiteral("WSL 仅在 Windows 上可用。")},
        {QStringLiteral("wsl.piNotInstalled"),
         QStringLiteral("未检测到 pi CLI。请在 WSL 中运行 npm i -g "
                        "@earendil-works/pi-coding-agent。")},
        {QStringLiteral("wsl.connectionFailed"),
         QStringLiteral("无法连接到所选 WSL 发行版和用户，请检查配置后重试。")},
        {QStringLiteral("project.notFound"), QStringLiteral("项目不存在，请刷新项目列表后重试。")},
        {QStringLiteral("session.notFound"), QStringLiteral("会话不存在，请刷新会话列表后重试。")},
        {QStringLiteral("session.messageNotFound"), QStringLiteral("未找到该消息的完整内容。")},
        {QStringLiteral("session.fileNotFound"), QStringLiteral("会话文件不存在，请刷新会话列表后重试。")},
        {QStringLiteral("session.exportFailed"), QStringLiteral("会话导出失败，请重试。")},
        // Oracle `mainAgent.renameFailed` / `mainAgent.nameRequired`: a live rename goes
        // through pi, and a refusal must reach the renderer instead of being swallowed.
        {QStringLiteral("mainAgent.renameFailed"), QStringLiteral("会话重命名失败，请重试。")},
        {QStringLiteral("mainAgent.nameRequired"), QStringLiteral("Agent 名称不能为空。")},
        {QStringLiteral("session.inUseDeleteBlocked"),
         QStringLiteral("会话“{title}”正在使用中，请先关闭 Agent 后再删除。")},
        {QStringLiteral("session.stopBeforeDelete"), QStringLiteral("请先停止会话运行实例，再删除会话。")},
        {QStringLiteral("session.deleteIdentityUnverified"), QStringLiteral("无法核实会话文件的占用状态，未执行删除。请稍后重试。")},
        {QStringLiteral("session.wslSafeTrashUnavailable"), QStringLiteral("此 WSL 环境的 mv 不支持安全回收（--no-copy），已停止删除。请升级 GNU coreutils 后重试。部分文件可能已移入回收站。")},
        {QStringLiteral("session.deletionInProgress"), QStringLiteral("正在删除会话，请稍后重试。")},
        {QStringLiteral("session.deleteRootNotAuthorized"),
         QStringLiteral("此会话不在当前或已验证的历史会话目录中。请将项目 .pi/settings.json 中的 sessionDir 暂时设为原会话目录，刷新会话列表后再重试。会话文件未被修改。")},
        {QStringLiteral("session.childRunningDeleteBlocked"),
         QStringLiteral("该会话的子会话仍在运行，请先停止子会话。")},
        {QStringLiteral("session.invalidArchivePath"), QStringLiteral("无效的归档会话路径。")},
        {QStringLiteral("session.newTitle"), QStringLiteral("新会话")},
        {QStringLiteral("session.anonymousTitle"), QStringLiteral("匿名聊天 - {project}")},
        {QStringLiteral("session.untitled"), QStringLiteral("未命名会话")},
        {QStringLiteral("session.todoGoal"), QStringLiteral("任务")},
        {QStringLiteral("session.todoGuidance"), QStringLiteral("补充")},
        {QStringLiteral("session.emptyPreview"), QStringLiteral("空会话")},
        {QStringLiteral("session.copyTitle"), QStringLiteral("{title} 副本")},
        {QStringLiteral("session.summaryPlaceholder"), QStringLiteral("[摘要]")},
        {QStringLiteral("session.imagePlaceholder"), QStringLiteral("[图片]")},
        {QStringLiteral("session.importedTitle"), QStringLiteral("{source} 会话")},
        {QStringLiteral("session.importedPreview"), QStringLiteral("已导入的 {source} 会话")},
        {QStringLiteral("mainNotification.sessionDone"), QStringLiteral("{title} 已完成响应")},
        {QStringLiteral("mainNotification.askPending"), QStringLiteral("「{title}」需要你的确认")},
        {QStringLiteral("mainNotification.askQuestion"),
         QStringLiteral("「{title}」正在询问：{question}")},
        {QStringLiteral("diagnostic.compactDone"), QStringLiteral("会话压缩完成")},
        // These three are emitted as timeline rows (`meta.i18nKey`) but their fallback
        // text is passed inline at the call site, so they were missing from this table —
        // which made the LAN page fall back to the English copy in Chinese.
        {QStringLiteral("diagnostic.extensionError"), QStringLiteral("扩展执行错误。")},
        {QStringLiteral("diagnostic.promptRejected"), QStringLiteral("消息发送失败。")},
        {QStringLiteral("diagnostic.promptDeliveryUnknown"),
         QStringLiteral("消息接收结果未知。请先检查当前会话，避免重复发送；必要时重启 Agent。")},
        {QStringLiteral("diagnostic.compactReconnected"),
         QStringLiteral("会话压缩完成，Agent 已自动重连")},
        // Auto-retry status is one upserted row per agent (`diagnostic.retry*`) plus the
        // generic failed-turn row. The renderer re-localizes them from `meta.i18nKey` and
        // shows them as toasts (FLOATING_FAILURE_KEYS), so a missing template here would
        // surface the raw key instead of a sentence.
        {QStringLiteral("diagnostic.retryScheduled"), QStringLiteral("正在自动重试 {count}")},
        {QStringLiteral("diagnostic.retryScheduledAfterDelay"),
         QStringLiteral("正在自动重试 {count}，{delaySeconds} 秒后重试")},
        {QStringLiteral("diagnostic.retrySucceeded"),
         QStringLiteral("自动重试成功，共重试 {attempt} 次")},
        {QStringLiteral("diagnostic.retryFailed"),
         QStringLiteral("自动重试失败，已重试 {count} 次")},
        // `addDetailedErrorMessage` variants: the failed-turn row re-localizes from these
        // keys, so the sentence and its `{attempt}/{maxAttempts}` params must match the
        // canonical main-process copy exactly (not a raw provider string).
        {QStringLiteral("diagnostic.requestFailed"), QStringLiteral("请求失败。")},
        {QStringLiteral("diagnostic.requestFailedAfterRetries"),
         QStringLiteral("请求失败。\n\n已自动重试：{attempt}/{maxAttempts} 次")},
        {QStringLiteral("diagnostic.requestFailedUnknown"), QStringLiteral("请求失败。请重试。")},
        {QStringLiteral("diagnostic.requestFailedUnknownAfterRetries"),
         QStringLiteral("请求失败。\n\n已自动重试：{attempt}/{maxAttempts} 次\n\n请稍后重试。")},
        {QStringLiteral("diagnostic.processReconnectFailed"),
         QStringLiteral("Agent 进程意外退出，自动重连失败")},
        {QStringLiteral("webService.invalidPort"),
         QStringLiteral("Web 服务端口必须是 1 到 65535 之间的整数。")},
        {QStringLiteral("webService.startFailed"),
         QStringLiteral("Web 服务启动失败，请检查主机和端口设置后重试。")},
        {QStringLiteral("mainProxy.enableFirst"), QStringLiteral("请先启用 pi agent 代理。")},
        {QStringLiteral("mainProxy.addressRequired"), QStringLiteral("代理地址为空。")},
        {QStringLiteral("mainProxy.bypassed"),
         QStringLiteral("检测目标命中绕过代理列表，本次不会经过代理。")},
        {QStringLiteral("mainProxy.success"), QStringLiteral("代理可用，目标返回 HTTP {status}")},
        {QStringLiteral("mainProxy.proxyProtocolUnsupported"),
         QStringLiteral("仅支持 http:// 或 https:// 代理地址。")},
        {QStringLiteral("mainProxy.targetProtocolUnsupported"),
         QStringLiteral("检测目标仅支持 HTTP/HTTPS。")},
        {QStringLiteral("mainProxy.connectStatus"), QStringLiteral("代理 CONNECT 返回 HTTP {status}")},
        {QStringLiteral("mainProxy.connectTimeout"), QStringLiteral("连接代理超时。")},
        {QStringLiteral("mainProxy.tlsTimeout"), QStringLiteral("TLS 握手超时。")},
        {QStringLiteral("mainProxy.responseTimeout"), QStringLiteral("等待响应超时。")},
        {QStringLiteral("mainProxy.headerTooLarge"), QStringLiteral("响应头过大。")},
        {QStringLiteral("mainProxy.invalidResponse"),
         QStringLiteral("代理返回了无效的 HTTP 响应。")},
        {QStringLiteral("mainProxy.closedEarly"), QStringLiteral("连接在返回响应前关闭。")},
        {QStringLiteral("mainProxy.invalidUrl"), QStringLiteral("代理地址格式无效。")},
        {QStringLiteral("mainProxy.connectionRefused"),
         QStringLiteral("代理端口拒绝连接，请确认代理客户端正在运行。")},
        {QStringLiteral("mainProxy.hostNotFound"),
         QStringLiteral("代理主机无法解析，请检查代理地址。")},
        {QStringLiteral("mainProxy.connectionReset"), QStringLiteral("连接被代理或远端重置。")},
        {QStringLiteral("mainProxy.connectionTimeout"),
         QStringLiteral("连接超时，请检查代理地址和网络。")},
        {QStringLiteral("mainProxy.unknownError"),
         QStringLiteral("代理检测失败，请检查配置和网络后重试。")},
        {QStringLiteral("mainTool.name"), QStringLiteral("工具：{name}")},
        {QStringLiteral("mainTool.status"), QStringLiteral("状态：{status}")},
        {QStringLiteral("mainTool.failed"), QStringLiteral("失败")},
        {QStringLiteral("mainTool.done"), QStringLiteral("完成")},
        {QStringLiteral("mainTool.unknown"), QStringLiteral("未记录结果")},
        {QStringLiteral("mainTool.arguments"), QStringLiteral("参数：\n{value}")},
        {QStringLiteral("mainTool.result"), QStringLiteral("结果：\n{value}")},
        {QStringLiteral("mainTool.details"), QStringLiteral("详情：\n{value}")},
        {QStringLiteral("mainTool.truncated"),
         QStringLiteral("…（已省略中间 {omitted} 字符，完整内容共 {total} 字符）")},
        {QStringLiteral("mainProjectResource.chatUnsupported"),
         QStringLiteral("Chat 项目不支持项目级资源。")},
        {QStringLiteral("mainProjectResource.skillNameCharacters"),
         QStringLiteral("Skill 名称只能包含小写字母、数字和连字符。")},
        {QStringLiteral("mainProjectResource.skillAlreadyExists"),
         QStringLiteral("项目 Skill 已存在：{name}")},
        {QStringLiteral("mainProjectResource.skillNotFound"), QStringLiteral("项目 Skill 不存在。")},
        {QStringLiteral("mainProjectResource.extensionNotFound"),
         QStringLiteral("项目 Extension 不存在。")},
        {QStringLiteral("mainProjectResource.pathOutsideProject"),
         QStringLiteral("资源路径不在项目目录内，已拒绝操作。")},
        {QStringLiteral("mainProjectResource.warningNameCharacters"),
         QStringLiteral("name 只能包含小写字母、数字和单个连字符")},
        {QStringLiteral("mainSkill.descriptionRequired"), QStringLiteral("Skill 描述不能为空。")},
        {QStringLiteral("mainSkill.unnamed"), QStringLiteral("未命名 Skill")},
        {QStringLiteral("mainSkill.warningNameRequired"), QStringLiteral("缺少 name")},
        {QStringLiteral("mainSkill.warningNameTooLong"), QStringLiteral("name 超过 64 个字符")},
        {QStringLiteral("mainSkill.warningDescriptionRequired"),
         QStringLiteral("缺少 description，pi 不会加载该 skill")},
        {QStringLiteral("mainSkill.warningDescriptionTooLong"),
         QStringLiteral("description 超过 1024 个字符")},
        {QStringLiteral("mainSkill.nameRequired"), QStringLiteral("Skill 名称不能为空。")},
        {QStringLiteral("mainSkill.sameName"), QStringLiteral("新旧名称相同。")},
        {QStringLiteral("mainSkill.nameRequiredDetailed"),
         QStringLiteral("Skill 名称不能为空，且至少包含一个字母或数字。")},
        {QStringLiteral("mainSkill.alreadyExists"), QStringLiteral("Skill 已存在：{name}")},
        {QStringLiteral("mainSkill.warningNameCharacters"),
         QStringLiteral("name 只能包含字母、数字和单个连字符")},
        {QStringLiteral("mainSkill.unknownLocation"), QStringLiteral("未知 Skill 位置：{id}")},
        {QStringLiteral("mainSkill.notFound"), QStringLiteral("Skill 不存在。")},
        {QStringLiteral("mainPrompt.nameRequiredDetailed"),
         QStringLiteral("模板名称不能为空，且至少包含一个字母或数字。")},
        {QStringLiteral("mainPrompt.descriptionRequired"), QStringLiteral("模板描述不能为空。")},
        {QStringLiteral("mainPrompt.alreadyExists"), QStringLiteral("模板已存在：{name}")},
        {QStringLiteral("mainPrompt.globalDeleteOnly"),
         QStringLiteral("只能删除全局 prompt templates 目录中的文件。")},
        {QStringLiteral("mainPrompt.fileNotFound"), QStringLiteral("模板文件不存在。")},
        {QStringLiteral("mainPrompt.globalEditOnly"),
         QStringLiteral("只能修改全局 prompt templates 目录中的文件。")},
        {QStringLiteral("mainPrompt.nameRequired"), QStringLiteral("模板名称不能为空。")},
        {QStringLiteral("mainPrompt.sameName"), QStringLiteral("新旧名称相同。")},
        {QStringLiteral("mainPrompt.notFound"), QStringLiteral("模板不存在：{name}")},
        {QStringLiteral("mainPrompt.notAuthorized"),
         QStringLiteral("只能访问已授权的全局或项目模板文件。")},
        {QStringLiteral("mainExtension.invalidPath"), QStringLiteral("扩展路径无效。")},
        {QStringLiteral("mainExtension.sourceRequired"), QStringLiteral("扩展来源不能为空。")},
        {QStringLiteral("mainExtension.builtInCannotUninstall"),
         QStringLiteral("PiDeck-Q 内置扩展不可卸载。")},
        {QStringLiteral("mainExtension.nameRequired"), QStringLiteral("扩展名称不能为空。")},
        {QStringLiteral("mainExtension.versionCheckFailed"),
         QStringLiteral("检查扩展版本失败。")},
        {QStringLiteral("mainExtension.commandFailed"),
         QStringLiteral("pi 扩展命令执行失败，请重试。")},
        {QStringLiteral("store.promptSearchFailed"),
         QStringLiteral("搜索 prompt 商店失败，请重试。")},
        {QStringLiteral("store.promptDetailFailed"),
         QStringLiteral("获取 prompt 详情失败，请重试。")},
        {QStringLiteral("store.promptImportFailed"), QStringLiteral("导入 prompt 失败，请重试。")},
        {QStringLiteral("store.invalidItemTitle"), QStringLiteral("标题中没有可用的文件名。")},
        {QStringLiteral("store.skillSearchFailed"),
         QStringLiteral("搜索 skill 商店失败，请重试。")},
        {QStringLiteral("store.skillImportFailed"), QStringLiteral("导入 skill 失败，请重试。")},
        {QStringLiteral("store.skillsShSearchFailed"),
         QStringLiteral("搜索 Skills.sh 失败，请重试。")},
        {QStringLiteral("store.skillsShInvalidSlug"),
         QStringLiteral("Skill 标识包含不安全字符。")},
        {QStringLiteral("store.skillsShInstallFailed"),
         QStringLiteral("安装 skill 失败，请重试。")},
        {QStringLiteral("store.yaoListFailed"), QStringLiteral("读取提示词库失败，请重试。")},
        {QStringLiteral("store.yaoDetailFailed"),
         QStringLiteral("读取提示词详情失败，请重试。")},
        {QStringLiteral("store.yaoPromptNotFound"), QStringLiteral("未找到该提示词。")},
        {QStringLiteral("store.yaoImportFailed"), QStringLiteral("导入提示词失败，请重试。")},
        {QStringLiteral("mainConfig.invalidJson"), QStringLiteral("JSON 格式错误。")},
        {QStringLiteral("mainConfig.fileNotEditable"), QStringLiteral("不允许编辑文件：{fileName}")},
        {QStringLiteral("mainConfig.modelsProvidersRequired"),
         QStringLiteral("models.json 缺少 providers 字段。")},
        {QStringLiteral("mainConfig.providerModelsRequired"),
         QStringLiteral("provider“{provider}”缺少 models 数组。")},
        {QStringLiteral("mainConfig.modelIdRequired"),
         QStringLiteral("provider“{provider}”的模型 #{index} 缺少有效 id。")},
        {QStringLiteral("mainConfig.emptyModelList"), QStringLiteral("接口返回了空的模型列表。")},
        {QStringLiteral("mainConfig.fetchTimeout"),
         QStringLiteral("请求超时，请检查网络或 baseUrl。")},
        {QStringLiteral("mainConfig.fetchModelsFailed"),
         QStringLiteral("获取模型列表失败，请检查 provider 配置后重试。")},
        {QStringLiteral("mainConfig.providerTestFailed"),
         QStringLiteral("Provider 连接测试失败，请检查配置后重试。")},
        {QStringLiteral("mainConfig.providerTestTimeout"),
         QStringLiteral("Provider 连接测试超时。这不一定表示兼容模式不受支持；请稍后重试，或使用更轻量的模型测试。")},
        {QStringLiteral("mainConfig.importFilesRequired"),
         QStringLiteral("导入文件缺少 files 字段，请确认它是 PiDeck-Q 导出的配置包。")},
        {QStringLiteral("mainConfig.emptyResponse"), QStringLiteral("（空响应）")},
        {QStringLiteral("mainConfig.toolCompatibility"), QStringLiteral("工具调用兼容：{name}")},
    };
    return table;
}

const Table &enUS()
{
    static const Table table{
        {QStringLiteral("app.modelSelectionRequired"), QStringLiteral("The selected model was removed. Choose a new model to continue.")},
        {QStringLiteral("app.visionModelSelectionRequired"), QStringLiteral("The vision bridge model is missing or was removed. Choose a new model in Settings before sending images.")},
        {QStringLiteral("subagents.modelRequired"), QStringLiteral("Pick a model before saving.")},
        {QStringLiteral("mainFile.unsupportedMoveType"),
         QStringLiteral("This file type cannot be moved. The source has been preserved.")},
        {QStringLiteral("mainFile.unsupportedCopyType"), QStringLiteral("This file type cannot be copied.")},
        {QStringLiteral("mainFile.renameTargetExists"),
         QStringLiteral("A file or folder with that name already exists. Nothing was renamed.")},
        {QStringLiteral("git.commitMessageModelRequired"),
         QStringLiteral("No commit-message model is configured. Go to Settings > Git to choose a provider "
                        "and model, then try again.")},
        {QStringLiteral("git.commitMessageBusy"),
         QStringLiteral("The previous commit-message generation is still running. Please wait and try again.")},
        {QStringLiteral("git.commitMessageTimeout"),
         QStringLiteral("Commit-message generation timed out. Please try again.")},
        {QStringLiteral("mainPi.pathRequired"), QStringLiteral("Enter the path to pi.cmd or pi.")},
        {QStringLiteral("mainPi.invalidWslUrl"), QStringLiteral("The WSL pi path is invalid.")},
        {QStringLiteral("mainPi.powershellUnsupported"),
         QStringLiteral("PowerShell pi.ps1 shims are not supported. Use the pi.cmd or pi.exe path "
                        "returned by where pi in Command Prompt.")},
        {QStringLiteral("mainPi.checkFailed"),
         QStringLiteral("Could not run pi CLI. Check its path and installation.")},
        {QStringLiteral("wsl.windowsOnly"), QStringLiteral("WSL is available only on Windows.")},
        {QStringLiteral("wsl.piNotInstalled"),
         QStringLiteral("pi CLI was not detected. Run npm i -g @earendil-works/pi-coding-agent "
                        "in WSL.")},
        {QStringLiteral("wsl.connectionFailed"),
         QStringLiteral("Could not connect to the selected WSL distribution and user. Check the "
                        "settings and try again.")},
        {QStringLiteral("project.notFound"),
         QStringLiteral("The project no longer exists. Refresh the project list and try again.")},
        {QStringLiteral("session.notFound"),
         QStringLiteral("The session no longer exists. Refresh the session list and try again.")},
        {QStringLiteral("session.fileNotFound"),
         QStringLiteral("The session file no longer exists. Refresh the session list and try again.")},
        {QStringLiteral("session.messageNotFound"),
         QStringLiteral("The full text of this message is no longer available.")},
        {QStringLiteral("session.exportFailed"), QStringLiteral("Failed to export the session. Try again.")},
        {QStringLiteral("mainAgent.renameFailed"),
         QStringLiteral("Failed to rename the session. Try again.")},
        {QStringLiteral("mainAgent.nameRequired"), QStringLiteral("The Agent name cannot be empty.")},
        {QStringLiteral("session.inUseDeleteBlocked"),
         QStringLiteral("Session \"{title}\" is in use. Close its Agent before deleting it.")},
        {QStringLiteral("session.stopBeforeDelete"),
         QStringLiteral("Stop the session runtime before deleting the session.")},
        {QStringLiteral("session.deleteIdentityUnverified"), QStringLiteral("Unable to verify session deletion identity. No files were deleted. Please retry.")},
        {QStringLiteral("session.wslSafeTrashUnavailable"), QStringLiteral("This WSL environment needs GNU mv with --no-copy for safe trash. Upgrade coreutils and retry. Some files may already be in trash.")},
        {QStringLiteral("session.deletionInProgress"), QStringLiteral("Session deletion is in progress. Please retry shortly.")},
        {QStringLiteral("session.deleteRootNotAuthorized"),
         QStringLiteral("This session is outside the current and verified previous session directories. Temporarily restore the original session directory in the project's .pi/settings.json sessionDir setting, refresh the session list, then retry. The session files have not been changed.")},
        {QStringLiteral("session.childRunningDeleteBlocked"),
         QStringLiteral("A child session is still running. Stop it first.")},
        {QStringLiteral("session.invalidArchivePath"), QStringLiteral("Invalid archived session path.")},
        {QStringLiteral("session.newTitle"), QStringLiteral("New session")},
        {QStringLiteral("session.anonymousTitle"), QStringLiteral("Anonymous chat - {project}")},
        {QStringLiteral("session.untitled"), QStringLiteral("Untitled session")},
        {QStringLiteral("session.todoGoal"), QStringLiteral("Task")},
        {QStringLiteral("session.todoGuidance"), QStringLiteral("Guidance")},
        {QStringLiteral("session.emptyPreview"), QStringLiteral("Empty session")},
        {QStringLiteral("session.copyTitle"), QStringLiteral("{title} copy")},
        {QStringLiteral("session.summaryPlaceholder"), QStringLiteral("[Summary]")},
        {QStringLiteral("session.imagePlaceholder"), QStringLiteral("[Image]")},
        {QStringLiteral("session.importedTitle"), QStringLiteral("{source} session")},
        {QStringLiteral("session.importedPreview"), QStringLiteral("Imported {source} session")},
        {QStringLiteral("mainNotification.sessionDone"), QStringLiteral("{title} completed its response")},
        {QStringLiteral("mainNotification.askPending"),
         QStringLiteral("“{title}” is waiting for your confirmation")},
        {QStringLiteral("mainNotification.askQuestion"),
         QStringLiteral("“{title}” is asking: {question}")},
        {QStringLiteral("diagnostic.compactDone"), QStringLiteral("Session compacted")},
        {QStringLiteral("diagnostic.extensionError"),
         QStringLiteral("The extension encountered an error.")},
        {QStringLiteral("diagnostic.promptRejected"),
         QStringLiteral("Failed to send the message.")},
        {QStringLiteral("diagnostic.promptDeliveryUnknown"),
         QStringLiteral("The message delivery result is unknown. Check the current session before "
                        "retrying to avoid sending it twice; restart the Agent if necessary.")},
        {QStringLiteral("diagnostic.compactReconnected"),
         QStringLiteral("Session compacted and the Agent reconnected automatically")},
        {QStringLiteral("diagnostic.retryScheduled"),
         QStringLiteral("Automatically retrying ({count})")},
        {QStringLiteral("diagnostic.retryScheduledAfterDelay"),
         QStringLiteral("Automatically retrying ({count}) in {delaySeconds} seconds")},
        {QStringLiteral("diagnostic.retrySucceeded"),
         QStringLiteral("Automatic retry succeeded after {attempt} attempts")},
        {QStringLiteral("diagnostic.retryFailed"),
         QStringLiteral("Automatic retry failed after {count} attempts")},
        {QStringLiteral("diagnostic.requestFailed"), QStringLiteral("The request failed.")},
        {QStringLiteral("diagnostic.requestFailedAfterRetries"),
         QStringLiteral("The request failed.\n\nAutomatic retries: {attempt}/{maxAttempts}")},
        {QStringLiteral("diagnostic.requestFailedUnknown"),
         QStringLiteral("Request failed. Try again.")},
        {QStringLiteral("diagnostic.requestFailedUnknownAfterRetries"),
         QStringLiteral("Request failed.\n\nAutomatic retries: {attempt}/{maxAttempts}\n\nTry again "
                        "shortly.")},
        {QStringLiteral("diagnostic.processReconnectFailed"),
         QStringLiteral("The Agent process exited unexpectedly and could not reconnect")},
        {QStringLiteral("webService.invalidPort"),
         QStringLiteral("The web service port must be an integer from 1 to 65535.")},
        {QStringLiteral("webService.startFailed"),
         QStringLiteral("Failed to start the web service. Check the host and port settings and try again.")},
        {QStringLiteral("mainProxy.enableFirst"), QStringLiteral("Enable the pi agent proxy first.")},
        {QStringLiteral("mainProxy.addressRequired"), QStringLiteral("The proxy address is empty.")},
        {QStringLiteral("mainProxy.bypassed"),
         QStringLiteral(
             "The test target matches the proxy bypass list, so this request will not use the "
             "proxy.")},
        {QStringLiteral("mainProxy.success"),
         QStringLiteral("The proxy is available. The target returned HTTP {status}.")},
        {QStringLiteral("mainProxy.proxyProtocolUnsupported"),
         QStringLiteral("Only http:// and https:// proxy addresses are supported.")},
        {QStringLiteral("mainProxy.targetProtocolUnsupported"),
         QStringLiteral("The test target must use HTTP or HTTPS.")},
        {QStringLiteral("mainProxy.connectStatus"),
         QStringLiteral("The proxy CONNECT request returned HTTP {status}.")},
        {QStringLiteral("mainProxy.connectTimeout"),
         QStringLiteral("The proxy connection timed out.")},
        {QStringLiteral("mainProxy.tlsTimeout"), QStringLiteral("The TLS handshake timed out.")},
        {QStringLiteral("mainProxy.responseTimeout"),
         QStringLiteral("Timed out while waiting for a response.")},
        {QStringLiteral("mainProxy.headerTooLarge"),
         QStringLiteral("The response headers are too large.")},
        {QStringLiteral("mainProxy.invalidResponse"),
         QStringLiteral("The proxy returned an invalid HTTP response.")},
        {QStringLiteral("mainProxy.closedEarly"),
         QStringLiteral("The connection closed before a response was received.")},
        {QStringLiteral("mainProxy.invalidUrl"), QStringLiteral("The proxy address is invalid.")},
        {QStringLiteral("mainProxy.connectionRefused"),
         QStringLiteral(
             "The proxy refused the connection. Confirm that the proxy client is running.")},
        {QStringLiteral("mainProxy.hostNotFound"),
         QStringLiteral("The proxy host could not be resolved. Check the proxy address.")},
        {QStringLiteral("mainProxy.connectionReset"),
         QStringLiteral("The proxy or remote server reset the connection.")},
        {QStringLiteral("mainProxy.connectionTimeout"),
         QStringLiteral("The connection timed out. Check the proxy address and network.")},
        {QStringLiteral("mainProxy.unknownError"),
         QStringLiteral(
             "The proxy test failed. Check the configuration and network, then try again.")},
        {QStringLiteral("mainTool.name"), QStringLiteral("Tool: {name}")},
        {QStringLiteral("mainTool.status"), QStringLiteral("Status: {status}")},
        {QStringLiteral("mainTool.failed"), QStringLiteral("Failed")},
        {QStringLiteral("mainTool.done"), QStringLiteral("Done")},
        {QStringLiteral("mainTool.unknown"), QStringLiteral("Result not recorded")},
        {QStringLiteral("mainTool.arguments"), QStringLiteral("Arguments:\n{value}")},
        {QStringLiteral("mainTool.result"), QStringLiteral("Result:\n{value}")},
        {QStringLiteral("mainTool.details"), QStringLiteral("Details:\n{value}")},
        {QStringLiteral("mainTool.truncated"),
         QStringLiteral("… ({omitted} characters omitted, {total} total)")},
        {QStringLiteral("mainProjectResource.chatUnsupported"),
         QStringLiteral("The chat project does not support project-level resources.")},
        {QStringLiteral("mainProjectResource.skillNameCharacters"),
         QStringLiteral("The skill name may contain only lowercase letters, numbers, and hyphens.")},
        {QStringLiteral("mainProjectResource.skillAlreadyExists"),
         QStringLiteral("Project skill already exists: {name}")},
        {QStringLiteral("mainProjectResource.skillNotFound"),
         QStringLiteral("The project skill no longer exists.")},
        {QStringLiteral("mainProjectResource.extensionNotFound"),
         QStringLiteral("The project extension no longer exists.")},
        {QStringLiteral("mainProjectResource.pathOutsideProject"),
         QStringLiteral("The resource path is outside the project directory. The operation was rejected.")},
        {QStringLiteral("mainProjectResource.warningNameCharacters"),
         QStringLiteral("name may contain only lowercase letters, numbers, and single hyphens")},
        {QStringLiteral("mainSkill.descriptionRequired"), QStringLiteral("The skill description is required.")},
        {QStringLiteral("mainSkill.unnamed"), QStringLiteral("Unnamed skill")},
        {QStringLiteral("mainSkill.warningNameRequired"), QStringLiteral("Missing name")},
        {QStringLiteral("mainSkill.warningNameTooLong"), QStringLiteral("name exceeds 64 characters")},
        {QStringLiteral("mainSkill.warningDescriptionRequired"),
         QStringLiteral("Missing description; pi will not load this skill")},
        {QStringLiteral("mainSkill.warningDescriptionTooLong"),
         QStringLiteral("description exceeds 1024 characters")},
        {QStringLiteral("mainSkill.nameRequired"), QStringLiteral("The skill name is required.")},
        {QStringLiteral("mainSkill.nameRequiredDetailed"),
         QStringLiteral("The skill name is required and must contain at least one letter or number.")},
        {QStringLiteral("mainSkill.alreadyExists"), QStringLiteral("Skill already exists: {name}")},
        {QStringLiteral("mainSkill.warningNameCharacters"),
         QStringLiteral("name may contain only letters, numbers, and single hyphens")},
        {QStringLiteral("mainSkill.unknownLocation"),
         QStringLiteral("Unknown skill location: {id}")},
        {QStringLiteral("mainSkill.notFound"), QStringLiteral("The skill no longer exists.")},
        {QStringLiteral("mainPrompt.nameRequiredDetailed"),
         QStringLiteral("The template name is required and must contain at least one letter or number.")},
        {QStringLiteral("mainPrompt.descriptionRequired"),
         QStringLiteral("The template description is required.")},
        {QStringLiteral("mainPrompt.alreadyExists"),
         QStringLiteral("Template already exists: {name}")},
        {QStringLiteral("mainPrompt.globalDeleteOnly"),
         QStringLiteral("Only files in the global prompt templates folder can be deleted.")},
        {QStringLiteral("mainPrompt.fileNotFound"),
         QStringLiteral("The template file no longer exists.")},
        {QStringLiteral("mainPrompt.globalEditOnly"),
         QStringLiteral("Only files in the global prompt templates folder can be edited.")},
        {QStringLiteral("mainPrompt.nameRequired"), QStringLiteral("The template name is required.")},
        {QStringLiteral("mainPrompt.sameName"),
         QStringLiteral("The new name is the same as the current name.")},
        {QStringLiteral("mainPrompt.notFound"), QStringLiteral("Template not found: {name}")},
        {QStringLiteral("mainPrompt.notAuthorized"),
         QStringLiteral("Only an authorized global or project template file can be accessed.")},
        {QStringLiteral("mainExtension.invalidPath"),
         QStringLiteral("The extension path is invalid.")},
        {QStringLiteral("mainExtension.sourceRequired"),
         QStringLiteral("The extension source is required.")},
        {QStringLiteral("mainExtension.builtInCannotUninstall"),
         QStringLiteral("Built-in PiDeck-Q extensions cannot be uninstalled.")},
        {QStringLiteral("mainExtension.nameRequired"),
         QStringLiteral("The extension name is required.")},
        {QStringLiteral("mainExtension.versionCheckFailed"),
         QStringLiteral("Failed to check the extension version.")},
        {QStringLiteral("mainExtension.commandFailed"),
         QStringLiteral("The pi extension command failed. Try again.")},
        {QStringLiteral("store.promptSearchFailed"),
         QStringLiteral("Failed to search the prompt store. Try again.")},
        {QStringLiteral("store.promptDetailFailed"),
         QStringLiteral("Failed to load the prompt details. Try again.")},
        {QStringLiteral("store.promptImportFailed"),
         QStringLiteral("Failed to import the prompt. Try again.")},
        {QStringLiteral("store.invalidItemTitle"),
         QStringLiteral("The title does not contain a usable file name.")},
        {QStringLiteral("store.skillSearchFailed"),
         QStringLiteral("Failed to search the skill store. Try again.")},
        {QStringLiteral("store.skillImportFailed"),
         QStringLiteral("Failed to import the skill. Try again.")},
        {QStringLiteral("store.skillsShSearchFailed"),
         QStringLiteral("Failed to search Skills.sh. Try again.")},
        {QStringLiteral("store.skillsShInvalidSlug"),
         QStringLiteral("The skill identifier contains unsafe characters.")},
        {QStringLiteral("store.skillsShInstallFailed"),
         QStringLiteral("Failed to install the skill. Try again.")},
        {QStringLiteral("store.yaoListFailed"),
         QStringLiteral("Failed to load the prompt library. Try again.")},
        {QStringLiteral("store.yaoDetailFailed"),
         QStringLiteral("Failed to load the prompt details. Try again.")},
        {QStringLiteral("store.yaoPromptNotFound"), QStringLiteral("The prompt was not found.")},
        {QStringLiteral("store.yaoImportFailed"),
         QStringLiteral("Failed to import the prompt. Try again.")},
        {QStringLiteral("mainSkill.sameName"),
         QStringLiteral("The new name is the same as the current name.")},
        {QStringLiteral("mainConfig.invalidJson"), QStringLiteral("The JSON is invalid.")},
        {QStringLiteral("mainConfig.fileNotEditable"),
         QStringLiteral("This file cannot be edited: {fileName}")},
        {QStringLiteral("mainConfig.modelsProvidersRequired"),
         QStringLiteral("models.json is missing the providers field.")},
        {QStringLiteral("mainConfig.providerModelsRequired"),
         QStringLiteral("Provider \"{provider}\" is missing its models array.")},
        {QStringLiteral("mainConfig.modelIdRequired"),
         QStringLiteral("Model #{index} for provider \"{provider}\" is missing a valid id.")},
        {QStringLiteral("mainConfig.emptyModelList"),
         QStringLiteral("The API returned an empty model list.")},
        {QStringLiteral("mainConfig.fetchTimeout"),
         QStringLiteral("The request timed out. Check the network connection or base URL.")},
        {QStringLiteral("mainConfig.fetchModelsFailed"),
         QStringLiteral("Failed to load the model list. Check the provider configuration and try again.")},
        {QStringLiteral("mainConfig.providerTestFailed"),
         QStringLiteral("The provider connection test failed. Check the configuration and try again.")},
        {QStringLiteral("mainConfig.providerTestTimeout"),
         QStringLiteral("The provider connection test timed out. This does not necessarily mean the "
                        "compatibility mode is unsupported; try again later or test with a lighter model.")},
        {QStringLiteral("mainConfig.importFilesRequired"),
         QStringLiteral("The import is missing its files field. Confirm that it is a PiDeck-Q "
                        "configuration export.")},
        {QStringLiteral("mainConfig.emptyResponse"), QStringLiteral("(empty response)")},
        {QStringLiteral("mainConfig.toolCompatibility"), QStringLiteral("Tool-call compatibility: {name}")},
    };
    return table;
}

QString interpolate(const QString &templateText, const QJsonObject &params)
{
    static const QRegularExpression placeholder(QStringLiteral("\\{([A-Za-z0-9_]+)\\}"));
    QVector<QRegularExpressionMatch> matches;
    QRegularExpressionMatchIterator iterator = placeholder.globalMatch(templateText);
    while (iterator.hasNext()) matches.append(iterator.next());
    QString result = templateText;
    // Replace from the end so earlier match offsets stay valid.
    for (int index = matches.size() - 1; index >= 0; --index) {
        const QRegularExpressionMatch match = matches.at(index);
        const QString name = match.captured(1);
        if (!params.contains(name)) continue;
        const QJsonValue value = params.value(name);
        const QString replacement = value.isString() ? value.toString()
            : value.isDouble() ? QString::number(value.toDouble())
            : value.isBool() ? (value.toBool() ? QStringLiteral("true") : QStringLiteral("false"))
                             : QString();
        result.replace(match.capturedStart(), match.capturedLength(), replacement);
    }
    return result;
}

} // namespace

Locale normalizeLocale(const QString &locale)
{
    return locale.trimmed().replace(QLatin1Char('_'), QLatin1Char('-')).toLower().startsWith(QLatin1String("en"))
        ? Locale::EnUS
        : Locale::ZhCN;
}

Locale resolveLocale(const QString &language)
{
    if (language == QLatin1String("pseudo")) return Locale::EnUS;
    if (language.isEmpty() || language == QLatin1String("system")) {
        const QStringList uiLanguages = QLocale::system().uiLanguages();
        return normalizeLocale(uiLanguages.isEmpty() ? QStringLiteral("zh-CN") : uiLanguages.first());
    }
    return normalizeLocale(language);
}

Locale resolveLocale(const QJsonObject &settings)
{
    return resolveLocale(settings.value(QStringLiteral("language")).toString(QStringLiteral("system")));
}

QString localeTag(Locale locale)
{
    return locale == Locale::EnUS ? QStringLiteral("en-US") : QStringLiteral("zh-CN");
}

QString translate(Locale locale, const QString &key, const QJsonObject &params)
{
    const Table &table = locale == Locale::EnUS ? enUS() : zhCN();
    const QString templateText = table.value(key);
    if (templateText.isEmpty()) return key;
    return interpolate(templateText, params);
}

QString text(const QString &language, const QString &key, const QJsonObject &params)
{
    return translate(resolveLocale(language), key, params);
}

Translator makeTranslator(Locale locale)
{
    return [locale](const QString &key, const QJsonObject &params) { return translate(locale, key, params); };
}

Translator makeTranslator(const QString &language)
{
    return makeTranslator(resolveLocale(language));
}

QString defaultGitCommitMessagePrompt(const QString &language)
{
    if (resolveLocale(language) == Locale::EnUS) {
        return QStringLiteral(
            "Please generate an English git commit message based on the following git diff.\n"
            "\n"
            "Changes:\n"
            "{diff}\n"
            "\n"
            "Gitmoji mapping:\n"
            "✨ feat - New feature\n"
            "🐛 fix - Bug fix\n"
            "📚 docs - Documentation update\n"
            "💎 style - Code formatting\n"
            "♻️ refactor - Refactoring\n"
            "🧪 test - Tests\n"
            "🔧 chore - Build/tooling\n"
            "\n"
            "Requirements:\n"
            "1. Start with the appropriate Gitmoji\n"
            "2. The first line briefly describes the affected module and change\n"
            "3. List specific changes on subsequent lines using -\n"
            "4. Output only the commit message, without explanation");
    }
    return QStringLiteral(
        "请根据以下 git diff 生成一条中文 git commit message。\n"
        "\n"
        "变更描述：\n"
        "{diff}\n"
        "\n"
        "Gitmoji 对应关系：\n"
        "✨ feat - 新功能\n"
        "🐛 fix - Bug 修复\n"
        "📚 docs - 文档更新\n"
        "💎 style - 代码格式\n"
        "♻️ refactor - 重构\n"
        "🧪 test - 测试\n"
        "🔧 chore - 构建/工具\n"
        "\n"
        "要求：\n"
        "1. 使用对应的 Gitmoji 开头\n"
        "2. 第一行简要说明修改的模块和做了什么\n"
        "3. 后续用 - 列出具体变更点\n"
        "4. 直接输出 commit 消息，不要解释");
}

QStringList keys()
{
    return zhCN().keys();
}

QJsonObject entries(Locale locale)
{
    const Table &table = locale == Locale::EnUS ? enUS() : zhCN();
    QStringList sorted = table.keys();
    sorted.sort();
    QJsonObject result;
    for (const QString &key : sorted) result.insert(key, table.value(key));
    return result;
}

} // namespace maincopy
