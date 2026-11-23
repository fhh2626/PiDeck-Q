#include "WebCopy.h"

#include <QHash>
#include <QJsonArray>
#include <QJsonObject>
#include <QStringList>

namespace webcopy {
namespace {

using Table = QHash<QString, QString>;

const Table &enUS()
{
    static const Table table{
        {QStringLiteral("webError.projectIdRequired"), QStringLiteral("projectId is required")},
        {QStringLiteral("webError.projectPathRequired"), QStringLiteral("Project path is required")},
        {QStringLiteral("webError.projectNotFound"), QStringLiteral("Project not found")},
        {QStringLiteral("webError.chatProjectProtected"),
         QStringLiteral("The built-in chat project cannot be deleted")},
        {QStringLiteral("webError.requestIdRequired"), QStringLiteral("requestId is required")},
        {QStringLiteral("webError.messageRequired"), QStringLiteral("message or images is required")},
        {QStringLiteral("webError.invalidMessagePage"),
         QStringLiteral("Invalid message page parameters")},
        {QStringLiteral("webError.runtimeTargetRequired"),
         QStringLiteral("A matching Session runtime target is required")},
        {QStringLiteral("webError.sessionBusy"),
         QStringLiteral("A Web request is already running for this session")},
        {QStringLiteral("webError.deleteSessionBlocked"),
         QStringLiteral("The session cannot be deleted while it is running")},
        {QStringLiteral("webError.invalidDeleteOptions"), QStringLiteral("Invalid session deletion options")},
        {QStringLiteral("webError.deleteRootNotAuthorized"), maincopy::translate(maincopy::Locale::EnUS, QStringLiteral("session.deleteRootNotAuthorized"))},
        {QStringLiteral("webError.wslSafeTrashUnavailable"), maincopy::translate(maincopy::Locale::EnUS, QStringLiteral("session.wslSafeTrashUnavailable"))},
        {QStringLiteral("webError.apiNotFound"), QStringLiteral("API not found")},
        {QStringLiteral("webError.unauthorized"),
         QStringLiteral("Unauthorized: open the Web service from PiDeck settings (QR code or Open "
                        "button).")},
        {QStringLiteral("webError.forbiddenOrigin"), QStringLiteral("Cross-site request rejected.")},
        {QStringLiteral("webError.internal"),
         QStringLiteral("The web service encountered an internal error")},
        {QStringLiteral("webError.streamUnavailable"),
         QStringLiteral("Streaming is not available in this build")},
    };
    return table;
}

const Table &zhCN()
{
    static const Table table{
        {QStringLiteral("webError.projectIdRequired"), QStringLiteral("projectId 不能为空")},
        {QStringLiteral("webError.projectPathRequired"), QStringLiteral("项目路径不能为空")},
        {QStringLiteral("webError.projectNotFound"), QStringLiteral("项目不存在")},
        {QStringLiteral("webError.chatProjectProtected"), QStringLiteral("内置聊天项目不能删除")},
        {QStringLiteral("webError.requestIdRequired"), QStringLiteral("requestId 不能为空")},
        {QStringLiteral("webError.messageRequired"), QStringLiteral("message 或 images 不能为空")},
        {QStringLiteral("webError.invalidMessagePage"), QStringLiteral("无效的消息分页参数")},
        {QStringLiteral("webError.runtimeTargetRequired"),
         QStringLiteral("需要匹配当前会话的运行目标")},
        {QStringLiteral("webError.sessionBusy"),
         QStringLiteral("当前会话已有 Web 请求正在运行")},
        {QStringLiteral("webError.deleteSessionBlocked"), QStringLiteral("会话运行中，无法删除")},
        {QStringLiteral("webError.invalidDeleteOptions"), QStringLiteral("无效的会话删除选项")},
        {QStringLiteral("webError.deleteRootNotAuthorized"), maincopy::translate(maincopy::Locale::ZhCN, QStringLiteral("session.deleteRootNotAuthorized"))},
        {QStringLiteral("webError.wslSafeTrashUnavailable"), maincopy::translate(maincopy::Locale::ZhCN, QStringLiteral("session.wslSafeTrashUnavailable"))},
        {QStringLiteral("webError.apiNotFound"), QStringLiteral("API 不存在")},
        {QStringLiteral("webError.unauthorized"),
         QStringLiteral("未授权：请在 PiDeck 设置中扫描二维码或点击“打开”访问 Web 服务。")},
        {QStringLiteral("webError.forbiddenOrigin"), QStringLiteral("已拒绝跨站请求。")},
        {QStringLiteral("webError.internal"), QStringLiteral("Web 服务发生内部错误")},
        {QStringLiteral("webError.streamUnavailable"), QStringLiteral("当前构建不支持流式响应")},
    };
    return table;
}

QJsonValue sanitized(const QJsonValue &value)
{
    if (value.isObject()) {
        const QJsonObject source = value.toObject();
        const bool rewriteError = source.value(QStringLiteral("i18nKey")).isString()
            && source.value(QStringLiteral("error")).isString();
        QJsonObject result;
        for (auto iterator = source.constBegin(); iterator != source.constEnd(); ++iterator) {
            // Internal diagnostics never cross the LAN boundary: they can embed absolute
            // paths and stack traces that a local browser should not read.
            if (iterator.key() == QLatin1String("debugDetails")
                || iterator.key() == QLatin1String("stack")) {
                continue;
            }
            if (rewriteError && iterator.key() == QLatin1String("error")) {
                result.insert(iterator.key(),
                              errorEn(iterator.value().toString()));
                continue;
            }
            result.insert(iterator.key(), sanitized(iterator.value()));
        }
        return result;
    }
    if (value.isArray()) {
        QJsonArray result;
        for (const QJsonValue &item : value.toArray()) result.append(sanitized(item));
        return result;
    }
    return value;
}

} // namespace

QString errorEn(const QString &key)
{
    const Table &table = enUS();
    const auto iterator = table.constFind(key);
    if (iterator != table.constEnd()) return iterator.value();
    return table.value(QStringLiteral("webError.internal"));
}

QString errorZh(const QString &key)
{
    const Table &table = zhCN();
    const auto iterator = table.constFind(key);
    if (iterator != table.constEnd()) return iterator.value();
    return table.value(QStringLiteral("webError.internal"));
}

QJsonObject entries(maincopy::Locale locale)
{
    const Table &table = locale == maincopy::Locale::EnUS ? enUS() : zhCN();
    QStringList sorted = table.keys();
    sorted.sort();
    QJsonObject result;
    for (const QString &key : sorted) result.insert(key, table.value(key));
    return result;
}

QByteArray unauthorizedPageHtml()
{
    // Static bilingual page: no user input is interpolated, so the response cannot be
    // turned into an XSS vector even if a token is echoed back to the browser.
    QString html = QStringLiteral("<!doctype html><meta charset=\"utf-8\"><title>PiDeck</title>"
                                  "<p>%1</p><p>%2</p>")
                       .arg(errorZh(QStringLiteral("webError.unauthorized")),
                            errorEn(QStringLiteral("webError.unauthorized")));
    return html.toUtf8();
}

QJsonValue serializePublic(const QJsonValue &value)
{
    return sanitized(value);
}

} // namespace webcopy
