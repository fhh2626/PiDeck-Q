#include "CatalogTypes.h"

#include <QJsonValue>

namespace catalogjson {
namespace {

constexpr int kScanPreviewLimit = 160;
const char *const kScanMetadataStringKeys[] = {
    "codexSessionId", "codexParentThreadId", "codexAgentRole", "codexAgentNickname",
};

void insertIfNotEmpty(QJsonObject *object, const char *key, const QString &value)
{
    if (value.isEmpty()) return;
    object->insert(QLatin1String(key), value);
}

} // namespace

QJsonObject toJson(const CatalogEntry &entry)
{
    QJsonObject object;
    object.insert(QStringLiteral("id"), entry.id);
    object.insert(QStringLiteral("projectId"), entry.projectId);
    insertIfNotEmpty(&object, "originKey", entry.originKey);
    object.insert(QStringLiteral("title"), entry.title);
    if (entry.noSession) object.insert(QStringLiteral("noSession"), true);
    object.insert(QStringLiteral("source"), entry.source);
    object.insert(QStringLiteral("environment"), entry.environment);
    insertIfNotEmpty(&object, "filePath", entry.filePath);
    insertIfNotEmpty(&object, "wslDistro", entry.wslDistro);
    insertIfNotEmpty(&object, "wslUser", entry.wslUser);
    insertIfNotEmpty(&object, "importedSourceId", entry.importedSourceId);
    object.insert(QStringLiteral("status"), entry.status);
    if (entry.hasIsInternalSubagent) {
        object.insert(QStringLiteral("isInternalSubagent"), entry.isInternalSubagent);
    }
    if (entry.hasParentSessionPath) {
        object.insert(QStringLiteral("parentSessionPath"), entry.parentSessionPath);
    }
    if (entry.hasScanMetadata) object.insert(QStringLiteral("scanMetadata"), entry.scanMetadata);
    if (entry.hasModel) {
        object.insert(QStringLiteral("model"), QJsonObject{
            {QStringLiteral("provider"), entry.modelProvider},
            {QStringLiteral("modelId"), entry.modelId},
        });
    }
    if (entry.hasThinkingLevel) object.insert(QStringLiteral("thinkingLevel"), entry.thinkingLevel);
    insertIfNotEmpty(&object, "piSessionId", entry.piSessionId);
    object.insert(QStringLiteral("createdAt"), double(entry.createdAt));
    object.insert(QStringLiteral("updatedAt"), double(entry.updatedAt));
    return object;
}

bool fromJson(const QJsonObject &value, CatalogEntry *out)
{
    CatalogEntry entry;
    const QJsonValue id = value.value(QStringLiteral("id"));
    const QJsonValue projectId = value.value(QStringLiteral("projectId"));
    const QJsonValue title = value.value(QStringLiteral("title"));
    const QJsonValue environment = value.value(QStringLiteral("environment"));
    const QJsonValue status = value.value(QStringLiteral("status"));
    // The oracle rejects the whole file when any record is structurally invalid,
    // rather than silently dropping it (a dropped record is a lost session).
    if (!id.isString() || !projectId.isString() || !title.isString()) return false;
    if (!environment.isString() || !status.isString()) return false;
    if (environment.toString() != QLatin1String("native")
        && environment.toString() != QLatin1String("wsl")) {
        return false;
    }
    if (status.toString() != QLatin1String("draft") && status.toString() != QLatin1String("active")) {
        return false;
    }
    entry.id = id.toString();
    entry.projectId = projectId.toString();
    entry.title = title.toString();
    entry.environment = environment.toString();
    entry.status = status.toString();
    entry.originKey = value.value(QStringLiteral("originKey")).toString();
    entry.noSession = value.value(QStringLiteral("noSession")).toBool(false);
    entry.source = value.value(QStringLiteral("source")).toString(QStringLiteral("pi"));
    entry.filePath = value.value(QStringLiteral("filePath")).toString();
    entry.wslDistro = value.value(QStringLiteral("wslDistro")).toString();
    entry.wslUser = value.value(QStringLiteral("wslUser")).toString();
    entry.importedSourceId = value.value(QStringLiteral("importedSourceId")).toString();
    if (value.contains(QStringLiteral("isInternalSubagent"))) {
        entry.hasIsInternalSubagent = true;
        entry.isInternalSubagent = value.value(QStringLiteral("isInternalSubagent")).toBool();
    }
    if (value.contains(QStringLiteral("parentSessionPath"))) {
        entry.hasParentSessionPath = true;
        entry.parentSessionPath = value.value(QStringLiteral("parentSessionPath")).toString();
    }
    if (value.contains(QStringLiteral("scanMetadata"))) {
        const QJsonValue metadata = sanitizeScanMetadata(value.value(QStringLiteral("scanMetadata")));
        if (metadata.isObject()) {
            entry.hasScanMetadata = true;
            entry.scanMetadata = metadata.toObject();
        }
    }
    const QJsonValue model = value.value(QStringLiteral("model"));
    if (model.isObject()) {
        const QJsonObject modelObject = model.toObject();
        const QJsonValue provider = modelObject.value(QStringLiteral("provider"));
        const QJsonValue modelId = modelObject.value(QStringLiteral("modelId"));
        if (provider.isString() && modelId.isString()) {
            entry.hasModel = true;
            entry.modelProvider = provider.toString();
            entry.modelId = modelId.toString();
        }
    }
    if (value.contains(QStringLiteral("thinkingLevel"))) {
        entry.hasThinkingLevel = true;
        entry.thinkingLevel = value.value(QStringLiteral("thinkingLevel")).toString();
    }
    entry.piSessionId = value.value(QStringLiteral("piSessionId")).toString();
    entry.createdAt = qint64(value.value(QStringLiteral("createdAt")).toDouble(0));
    entry.updatedAt = qint64(value.value(QStringLiteral("updatedAt")).toDouble(0));
    *out = entry;
    return true;
}

QJsonValue sanitizeScanMetadata(const QJsonValue &value)
{
    if (!value.isObject()) return QJsonValue(QJsonValue::Undefined);
    const QJsonObject raw = value.toObject();
    QJsonObject metadata;
    const QJsonValue projectPath = raw.value(QStringLiteral("projectPath"));
    if (projectPath.isString()) metadata.insert(QStringLiteral("projectPath"), projectPath.toString());
    const QJsonValue preview = raw.value(QStringLiteral("preview"));
    if (preview.isString()) {
        QString text = preview.toString();
        if (text.size() > kScanPreviewLimit) text = text.left(kScanPreviewLimit);
        metadata.insert(QStringLiteral("preview"), text);
    }
    const QJsonValue messageCount = raw.value(QStringLiteral("messageCount"));
    if (messageCount.isDouble()) {
        const double count = messageCount.toDouble();
        const bool integral = count == double(qint64(count));
        if (integral && count >= 0 && count <= 1'000'000) {
            metadata.insert(QStringLiteral("messageCount"), double(qint64(count)));
        }
    }
    const QJsonValue wsl = raw.value(QStringLiteral("wsl"));
    if (wsl.isBool()) metadata.insert(QStringLiteral("wsl"), wsl.toBool());
    const QJsonValue threadSource = raw.value(QStringLiteral("codexThreadSource"));
    if (threadSource.isString()
        && (threadSource.toString() == QLatin1String("user")
            || threadSource.toString() == QLatin1String("subagent"))) {
        metadata.insert(QStringLiteral("codexThreadSource"), threadSource.toString());
    }
    for (const char *key : kScanMetadataStringKeys) {
        const QJsonValue entry = raw.value(QLatin1String(key));
        if (entry.isString()) metadata.insert(QLatin1String(key), entry.toString());
    }
    return metadata;
}

bool sameScanMetadata(const QJsonValue &left, const QJsonValue &right)
{
    const QJsonObject a = left.isObject() ? left.toObject() : QJsonObject{};
    const QJsonObject b = right.isObject() ? right.toObject() : QJsonObject{};
    // The oracle compares a fixed key set; extra keys can never appear because both
    // sides went through sanitizeScanMetadata.
    return a == b;
}

CatalogEntry cloneEntry(const CatalogEntry &entry)
{
    return entry;
}

} // namespace catalogjson
