#include "WebClientCopy.h"

#include "WebCopy.h"

#include <QHash>
#include <QJsonDocument>
#include <QStringList>

namespace webclientcopy {
namespace {

using Table = QHash<QString, QString>;

/** `webZhCN` in WebI18n.ts. Keys must stay identical to `enUS()`. */
const Table &zhCN()
{
    static const Table table{
        {QStringLiteral("web.projects"), QStringLiteral("项目")},
        {QStringLiteral("web.sessions"), QStringLiteral("会话")},
        {QStringLiteral("web.chooseSession"), QStringLiteral("选择或创建会话")},
        {QStringLiteral("web.newProject"), QStringLiteral("新建项目")},
        {QStringLiteral("web.projectPathPlaceholder"), QStringLiteral("输入项目目录路径")},
        {QStringLiteral("web.createProject"), QStringLiteral("添加项目")},
        {QStringLiteral("web.model"), QStringLiteral("模型")},
        {QStringLiteral("web.thinking"), QStringLiteral("思考")},
        {QStringLiteral("web.connecting"), QStringLiteral("连接中...")},
        {QStringLiteral("web.connected"), QStringLiteral("已连接")},
        {QStringLiteral("web.closeSession"), QStringLiteral("关闭会话运行实例")},
        {QStringLiteral("web.stopResponse"), QStringLiteral("停止响应")},
        {QStringLiteral("web.emptySelection"), QStringLiteral("从左侧选择项目创建会话，或选择现有会话。")},
        {QStringLiteral("web.promptPlaceholder"), QStringLiteral("发送消息到当前会话")},
        {QStringLiteral("web.send"), QStringLiteral("发送")},
        {QStringLiteral("web.composerHint"), QStringLiteral("Enter 发送，Shift/Ctrl + Enter 换行")},
        {QStringLiteral("web.opening"), QStringLiteral("正在打开...")},
        {QStringLiteral("web.responding"), QStringLiteral("正在响应...")},
        {QStringLiteral("web.noMessages"), QStringLiteral("暂无消息")},
        {QStringLiteral("web.streamFailed"), QStringLiteral("流式连接失败，请刷新后重试")},
        {QStringLiteral("web.closing"), QStringLiteral("关闭中")},
        {QStringLiteral("web.processing"), QStringLiteral("处理中")},
        {QStringLiteral("web.role.user"), QStringLiteral("用户")},
        {QStringLiteral("web.role.assistant"), QStringLiteral("助手")},
        {QStringLiteral("web.role.tool"), QStringLiteral("工具")},
        {QStringLiteral("web.role.system"), QStringLiteral("系统")},
        {QStringLiteral("web.role.error"), QStringLiteral("错误")},
        {QStringLiteral("web.status.starting"), QStringLiteral("启动中")},
        {QStringLiteral("web.status.running"), QStringLiteral("运行中")},
        {QStringLiteral("web.status.idle"), QStringLiteral("空闲")},
        {QStringLiteral("web.status.closed"), QStringLiteral("已关闭")},
        {QStringLiteral("web.status.error"), QStringLiteral("错误")},
        {QStringLiteral("web.status.draft"), QStringLiteral("草稿")},
        {QStringLiteral("web.status.active"), QStringLiteral("已保存")},
        {QStringLiteral("web.status.unknown"), QStringLiteral("未知状态")},
    };
    return table;
}

/** `webEnUS` in WebI18n.ts. */
const Table &enUS()
{
    static const Table table{
        {QStringLiteral("web.projects"), QStringLiteral("Projects")},
        {QStringLiteral("web.sessions"), QStringLiteral("Sessions")},
        {QStringLiteral("web.chooseSession"), QStringLiteral("Select or create a session")},
        {QStringLiteral("web.newProject"), QStringLiteral("New project")},
        {QStringLiteral("web.projectPathPlaceholder"), QStringLiteral("Enter a project directory path")},
        {QStringLiteral("web.createProject"), QStringLiteral("Add project")},
        {QStringLiteral("web.model"), QStringLiteral("Model")},
        {QStringLiteral("web.thinking"), QStringLiteral("Thinking")},
        {QStringLiteral("web.connecting"), QStringLiteral("Connecting...")},
        {QStringLiteral("web.connected"), QStringLiteral("Connected")},
        {QStringLiteral("web.closeSession"), QStringLiteral("Close session runtime")},
        {QStringLiteral("web.stopResponse"), QStringLiteral("Stop response")},
        {QStringLiteral("web.emptySelection"),
         QStringLiteral("Select a project to create a session, or select an existing session.")},
        {QStringLiteral("web.promptPlaceholder"), QStringLiteral("Send a message to the current session")},
        {QStringLiteral("web.send"), QStringLiteral("Send")},
        {QStringLiteral("web.composerHint"),
         QStringLiteral("Enter to send, Shift/Ctrl + Enter for a new line")},
        {QStringLiteral("web.opening"), QStringLiteral("Opening...")},
        {QStringLiteral("web.responding"), QStringLiteral("Responding...")},
        {QStringLiteral("web.noMessages"), QStringLiteral("No messages")},
        {QStringLiteral("web.streamFailed"), QStringLiteral("Stream connection failed, refresh to retry")},
        {QStringLiteral("web.closing"), QStringLiteral("Closing")},
        {QStringLiteral("web.processing"), QStringLiteral("Processing")},
        {QStringLiteral("web.role.user"), QStringLiteral("User")},
        {QStringLiteral("web.role.assistant"), QStringLiteral("Assistant")},
        {QStringLiteral("web.role.tool"), QStringLiteral("Tool")},
        {QStringLiteral("web.role.system"), QStringLiteral("System")},
        {QStringLiteral("web.role.error"), QStringLiteral("Error")},
        {QStringLiteral("web.status.starting"), QStringLiteral("Starting")},
        {QStringLiteral("web.status.running"), QStringLiteral("Running")},
        {QStringLiteral("web.status.idle"), QStringLiteral("Idle")},
        {QStringLiteral("web.status.closed"), QStringLiteral("Closed")},
        {QStringLiteral("web.status.error"), QStringLiteral("Error")},
        {QStringLiteral("web.status.draft"), QStringLiteral("Draft")},
        {QStringLiteral("web.status.active"), QStringLiteral("Saved")},
        {QStringLiteral("web.status.unknown"), QStringLiteral("Unknown status")},
    };
    return table;
}

const Table &tableFor(maincopy::Locale locale)
{
    return locale == maincopy::Locale::EnUS ? enUS() : zhCN();
}

/** Sorted insertion: `QJsonObject` output must not depend on the hash seed. */
void mergeInto(QJsonObject *target, const Table &table)
{
    QStringList sorted = table.keys();
    sorted.sort();
    for (const QString &key : sorted) target->insert(key, table.value(key));
}

} // namespace

QJsonObject uiEntries(maincopy::Locale locale)
{
    QJsonObject result;
    mergeInto(&result, tableFor(locale));
    return result;
}

QJsonObject localeTable(maincopy::Locale locale)
{
    QJsonObject result = maincopy::entries(locale);
    const QJsonObject errors = webcopy::entries(locale);
    for (auto iterator = errors.constBegin(); iterator != errors.constEnd(); ++iterator) {
        result.insert(iterator.key(), iterator.value());
    }
    mergeInto(&result, tableFor(locale));
    return result;
}

QJsonObject dictionaries()
{
    QJsonObject result;
    result.insert(QStringLiteral("zh-CN"), localeTable(maincopy::Locale::ZhCN));
    result.insert(QStringLiteral("en-US"), localeTable(maincopy::Locale::EnUS));
    return result;
}

QByteArray serializedDictionaries()
{
    QByteArray json = QJsonDocument(dictionaries()).toJson(QJsonDocument::Compact);
    // Same guard as `serializeWebClientDictionaries()`; a raw `<` could end `</script>`.
    json.replace('<', "\\u003c");
    return json;
}

} // namespace webclientcopy
