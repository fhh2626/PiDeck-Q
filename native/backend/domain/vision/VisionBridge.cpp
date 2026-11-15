#include "VisionBridge.h"

#include "JsonFile.h"

#include <cmath>

#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonArray>
#include <QJsonDocument>
#include <QRegularExpression>
#include <QStringList>

namespace vision {
namespace {

const QString kConfigFile = QStringLiteral("pi-deck-vision.json");
const QString kLogFile = QStringLiteral("pi-deck-vision.log");
const QString kEventFile = QStringLiteral("pi-deck-vision-events.jsonl");
/** The extension already rotates at 512 KiB; this is the second line of defence. */
constexpr int kMaxLogReturnChars = 256 * 1024;
constexpr int kMaxEventReturnChars = 1024 * 1024;

int intField(const QJsonValue &value, int maximum, bool allowZero)
{
    if (!value.isDouble()) return -1;
    const double raw = value.toDouble();
    // NaN/Infinity are not representable in JSON, but a huge value still must not pass.
    if (!std::isfinite(raw)) return -1;
    const int truncated = int(raw);
    const bool lowerOk = allowZero ? truncated >= 0 : truncated > 0;
    return lowerOk && truncated <= maximum ? truncated : -1;
}

/** Whitelist validation; a null return means "reject the save". */
QJsonObject sanitize(const QJsonValue &input)
{
    if (!input.isObject()) return {};
    const QJsonObject raw = input.toObject();
    const QString provider = raw.value(QStringLiteral("provider")).toString().trimmed().left(128);
    const QString model = raw.value(QStringLiteral("model")).toString().trimmed().left(128);
    // Without a provider and a model the bridge cannot resolve an endpoint at all.
    if (provider.isEmpty() || model.isEmpty()) return {};

    QJsonObject next{
        {QStringLiteral("enabled"), raw.value(QStringLiteral("enabled")).toBool(true)},
        {QStringLiteral("provider"), provider},
        {QStringLiteral("model"), model},
    };
    const QString api = raw.value(QStringLiteral("api")).toString();
    if (api == QStringLiteral("openai-completions") || api == QStringLiteral("anthropic-messages")
        || api == QStringLiteral("google-generative-ai")) {
        next.insert(QStringLiteral("api"), api);
    }
    static const QRegularExpression httpUrl(QStringLiteral("^https?://\\S+$"),
                                            QRegularExpression::CaseInsensitiveOption);
    const QString baseUrl = raw.value(QStringLiteral("baseUrl")).toString().trimmed();
    if (!baseUrl.isEmpty() && httpUrl.match(baseUrl).hasMatch()) {
        next.insert(QStringLiteral("baseUrl"), baseUrl.left(512));
    }
    const QString apiKey = raw.value(QStringLiteral("apiKey")).toString().trimmed();
    if (!apiKey.isEmpty()) next.insert(QStringLiteral("apiKey"), apiKey.left(512));

    // The file is the extension's only runtime source, so every numeric field is written
    // explicitly: an absent field would look like "not saved" in the settings page.
    const int maxTokens = intField(raw.value(QStringLiteral("maxTokens")), 32'768, true);
    next.insert(QStringLiteral("maxTokens"), maxTokens >= 0 ? maxTokens : 0);
    const int timeoutMs = intField(raw.value(QStringLiteral("timeoutMs")), 300'000, false);
    next.insert(QStringLiteral("timeoutMs"), timeoutMs > 0 ? timeoutMs : 120'000);
    const int concurrency = intField(raw.value(QStringLiteral("concurrency")), 16, false);
    next.insert(QStringLiteral("concurrency"), concurrency > 0 ? concurrency : 2);

    QString prompt = raw.value(QStringLiteral("promptTemplate")).toString().trimmed();
    if (prompt.isEmpty()) prompt = defaultPrompt();
    next.insert(QStringLiteral("promptTemplate"), prompt.left(4'000));
    return next;
}

/** Fill a missing key/baseUrl from the provider block of pi's models.json. */
void inheritProviderCredentials(const QString &modelsConfigDir, QJsonObject *config)
{
    QJsonValue models;
    if (jsonfile::readJson(QDir(modelsConfigDir).filePath(QStringLiteral("models.json")), &models, nullptr)
        != jsonfile::ReadState::Ok) {
        return;
    }
    const QString provider = config->value(QStringLiteral("provider")).toString();
    const QJsonObject entry = models.toObject().value(QStringLiteral("providers")).toObject()
                                  .value(provider).toObject();
    if (entry.isEmpty()) return;
    if (!config->contains(QStringLiteral("apiKey"))) {
        const QString apiKey = entry.value(QStringLiteral("apiKey")).toString();
        if (!apiKey.isEmpty()) config->insert(QStringLiteral("apiKey"), apiKey);
    }
    if (!config->contains(QStringLiteral("baseUrl"))) {
        const QString baseUrl = entry.value(QStringLiteral("baseUrl")).toString();
        if (!baseUrl.isEmpty()) config->insert(QStringLiteral("baseUrl"), baseUrl);
    }
}

QJsonObject readFileInfo(const QString &path, QString *content, qint64 *size)
{
    QFile file(path);
    if (!file.open(QIODevice::ReadOnly)) return QJsonObject{{QStringLiteral("exists"), false}};
    const QByteArray bytes = file.readAll();
    if (content) *content = QString::fromUtf8(bytes);
    if (size) *size = bytes.size();
    return QJsonObject{{QStringLiteral("exists"), true}};
}

} // namespace

QString defaultPrompt()
{
    // Byte-identical to the oracle's VISION_DEFAULT_PROMPT (src/main/settings/
    // visionBridgeConfig.ts): the extension reads the saved value, so a different default
    // would change every user's prompt the first time they save. The extension's own
    // DEFAULT_PROMPT has since grown a longer wording; that drift is pre-existing and
    // lives in files this port must not edit, so the oracle stays authoritative here.
    return QStringLiteral(
        "请详细描述这张图片的内容。如果图片中有文字（代码、报错、UI 文案、文档等），请完整准确地转录所有可见文字；"
        "如果是图表，请说明类型、坐标轴含义和关键数值；如果涉及界面，请描述布局与元素。输出使用中文。");
}

QString configDir(const QString &agentDir)
{
    const QString override = qEnvironmentVariable("PIDECK_VISION_CONFIG_DIR").trimmed();
    return override.isEmpty() ? agentDir : override;
}

QJsonObject state(const QString &agentDir)
{
    const QString dir = configDir(agentDir);
    QJsonValue parsed;
    QJsonValue config(QJsonValue::Null);
    if (jsonfile::readJson(QDir(dir).filePath(kConfigFile), &parsed, nullptr)
        == jsonfile::ReadState::Ok) {
        const QJsonObject sanitized = sanitize(parsed);
        if (!sanitized.isEmpty()) config = sanitized;
    }
    return QJsonObject{
        {QStringLiteral("config"), config},
        {QStringLiteral("configDir"), dir},
    };
}

QJsonObject saveConfig(const QString &agentDir, const QJsonValue &input,
                       const QString &modelsConfigDir)
{
    QJsonObject next = sanitize(input);
    if (next.isEmpty()) {
        return QJsonObject{{QStringLiteral("ok"), false},
                           {QStringLiteral("error"),
                            QStringLiteral("provider/model 必填，或字段非法")}};
    }
    if (!next.contains(QStringLiteral("apiKey")) || !next.contains(QStringLiteral("baseUrl"))) {
        inheritProviderCredentials(modelsConfigDir, &next);
        // A gateway provider is often configured as a bare URL, so use it as the endpoint.
        if (!next.contains(QStringLiteral("baseUrl"))) {
            static const QRegularExpression httpUrl(QStringLiteral("^https?://\\S+$"),
                                                    QRegularExpression::CaseInsensitiveOption);
            const QString provider = next.value(QStringLiteral("provider")).toString();
            if (httpUrl.match(provider).hasMatch()) {
                QString trimmed = provider;
                while (trimmed.endsWith(QLatin1Char('/'))) trimmed.chop(1);
                next.insert(QStringLiteral("baseUrl"), trimmed);
            }
        }
    }
    const QString dir = configDir(agentDir);
    QString error;
    if (!jsonfile::writeJsonAtomic(QDir(dir).filePath(kConfigFile), next, &error)) {
        return QJsonObject{{QStringLiteral("ok"), false}, {QStringLiteral("error"), error}};
    }
    return QJsonObject{{QStringLiteral("ok"), true}};
}

QJsonObject log(const QString &agentDir)
{
    const QString path = QDir(configDir(agentDir)).filePath(kLogFile);
    const QFileInfo info(path);
    if (!info.exists()) {
        return QJsonObject{{QStringLiteral("exists"), false},
                           {QStringLiteral("size"), 0},
                           {QStringLiteral("content"), QString()},
                           {QStringLiteral("truncated"), false}};
    }
    QString content;
    qint64 size = 0;
    readFileInfo(path, &content, &size);
    const bool truncated = content.size() > kMaxLogReturnChars;
    return QJsonObject{
        {QStringLiteral("exists"), true},
        {QStringLiteral("size"), double(size)},
        {QStringLiteral("content"), truncated ? content.right(kMaxLogReturnChars) : content},
        {QStringLiteral("truncated"), truncated},
    };
}

QJsonObject events(const QString &agentDir, int limit)
{
    const QString path = QDir(configDir(agentDir)).filePath(kEventFile);
    const QFileInfo info(path);
    if (!info.exists()) {
        return QJsonObject{{QStringLiteral("exists"), false},
                           {QStringLiteral("size"), 0},
                           {QStringLiteral("events"), QJsonArray{}},
                           {QStringLiteral("truncated"), false}};
    }
    QString content;
    qint64 size = 0;
    readFileInfo(path, &content, &size);
    QStringList lines;
    for (const QString &line : content.split(QLatin1Char('\n'))) {
        if (!line.isEmpty()) lines.append(line);
    }
    if (limit > 0 && lines.size() > limit) lines = lines.mid(lines.size() - limit);
    QJsonArray parsedEvents;
    for (const QString &line : lines) {
        // A half-written line is normal while the extension appends, so bad lines are
        // skipped instead of failing the whole read.
        const QJsonDocument document = QJsonDocument::fromJson(line.toUtf8());
        if (!document.isObject()) continue;
        const QJsonObject entry = document.object();
        if (!entry.value(QStringLiteral("ts")).isDouble()) continue;
        if (!entry.value(QStringLiteral("items")).isArray()) continue;
        parsedEvents.append(entry);
    }
    return QJsonObject{
        {QStringLiteral("exists"), true},
        {QStringLiteral("size"), double(size)},
        {QStringLiteral("events"), parsedEvents},
        {QStringLiteral("truncated"), content.size() > kMaxEventReturnChars},
    };
}

QJsonObject clearLog(const QString &agentDir)
{
    const QString path = QDir(configDir(agentDir)).filePath(kLogFile);
    if (!QFileInfo::exists(path)) return QJsonObject{{QStringLiteral("ok"), true}};
    return QJsonObject{{QStringLiteral("ok"), QFile::remove(path)}};
}

QJsonObject clearEvents(const QString &agentDir)
{
    const QString path = QDir(configDir(agentDir)).filePath(kEventFile);
    if (!QFileInfo::exists(path)) return QJsonObject{{QStringLiteral("ok"), true}};
    return QJsonObject{{QStringLiteral("ok"), QFile::remove(path)}};
}

} // namespace vision
