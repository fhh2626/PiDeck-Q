#include "ModelSpecs.h"

#include <algorithm>
#include <optional>

#include <QDir>
#include <QFileInfo>
#include <QHash>
#include <QJsonArray>
#include <QJsonDocument>
#include <QMutex>
#include <QMutexLocker>
#include <QSet>
#include <QSqlDatabase>
#include <QSqlQuery>
#include <QStringList>
#include <QVariant>

namespace modelspecs {
namespace {

/**
 * Provider prefixes that may be stripped before a models.dev lookup.
 *
 * Only known vendor names are stripped: a user-defined relay prefix such as
 * `myrelay/` must stay part of the id, otherwise an unrelated model would match.
 */
const QSet<QString> &knownProviderAliases()
{
    static const QSet<QString> aliases = {
        QStringLiteral("anthropic"), QStringLiteral("openai"), QStringLiteral("google"),
        QStringLiteral("deepseek"), QStringLiteral("zhipuai"), QStringLiteral("moonshotai"),
        QStringLiteral("moonshot"), QStringLiteral("minimax"), QStringLiteral("alibaba"),
        QStringLiteral("qwen"), QStringLiteral("meta"), QStringLiteral("mistralai"),
        QStringLiteral("mistral"), QStringLiteral("xai"), QStringLiteral("grok"),
        QStringLiteral("groq"), QStringLiteral("cerebras"), QStringLiteral("togetherai"),
        QStringLiteral("together"), QStringLiteral("cohere"), QStringLiteral("perplexity"),
        QStringLiteral("amazon"), QStringLiteral("bedrock"), QStringLiteral("azure"),
        QStringLiteral("baidu"), QStringLiteral("ernie"), QStringLiteral("tencent"),
        QStringLiteral("doubao"), QStringLiteral("volcengine"), QStringLiteral("kimi"),
        QStringLiteral("glm"), QStringLiteral("01-ai"), QStringLiteral("deepinfra"),
        QStringLiteral("fireworks"), QStringLiteral("novita"), QStringLiteral("siliconflow"),
        QStringLiteral("huggingface"), QStringLiteral("ollama"), QStringLiteral("lmstudio"),
        QStringLiteral("openrouter"), QStringLiteral("nvidia"), QStringLiteral("sakana"),
        QStringLiteral("upstage"), QStringLiteral("yi"), QStringLiteral("stepfun"),
        QStringLiteral("lingyi"), QStringLiteral("internlm"), QStringLiteral("baichuan"),
        QStringLiteral("spark"),
    };
    return aliases;
}

struct OpenRouterEntry {
    QString id;
    qint64 contextWindow = 0;
    qint64 maxTokens = 0;
    QStringList inputModalities;
};

struct ModelsDevEntry {
    QString provider;
    QString id;
    QString source;
    qint64 contextWindow = 0;
    qint64 maxTokens = 0;
    std::optional<bool> reasoning;
    std::optional<bool> toolCall;
    std::optional<bool> attachment;
    QStringList inputModalities;
};

struct Index {
    bool loaded = false;
    int rowCount = 0;
    QHash<QString, OpenRouterEntry> openrouterById;
    QHash<QString, OpenRouterEntry> openrouterByIdLower;
    QHash<QString, QList<OpenRouterEntry>> openrouterByTail;
    QHash<QString, QList<OpenRouterEntry>> openrouterByTailLower;
    QHash<QString, ModelsDevEntry> modelsDevById;
    QHash<QString, ModelsDevEntry> modelsDevByIdLower;
    QHash<QString, qint64> modelsDevOutputByQualifiedId;
    QList<OpenRouterEntry> openrouterContains;
    QList<ModelsDevEntry> modelsDevContains;
    QSet<QString> knownProviders;
};

/** Cache keyed by database path, so one process can serve several resource roots. */
QHash<QString, Index> &cache()
{
    static QHash<QString, Index> value;
    return value;
}

QMutex &cacheMutex()
{
    static QMutex value;
    return value;
}

void putLowerOpenRouter(QHash<QString, OpenRouterEntry> *map, const QString &key,
                        const OpenRouterEntry &entry)
{
    const auto existing = map->constFind(key);
    // Prefer the variant that carries a context window: the capability bits are the same.
    if (existing == map->constEnd()
        || (existing.value().contextWindow == 0 && entry.contextWindow != 0)) {
        map->insert(key, entry);
    }
}

QStringList mergedModalities(const QStringList &left, const QStringList &right)
{
    QStringList merged = left;
    for (const QString &value : right) {
        if (!merged.contains(value)) merged.append(value);
    }
    return merged;
}

/** Attachment capability consensus: explicit false vetoes, true needs two vendors. */
std::optional<bool> consensusAttachment(const QHash<QString, int> &trueCount,
                                        const QHash<QString, int> &falseCount, const QString &key,
                                        const ModelsDevEntry &entry)
{
    if (entry.source == QStringLiteral("builtin")) return entry.attachment;
    if (falseCount.value(key, 0) > 0) return false;
    if (trueCount.value(key, 0) >= 2) return true;
    return std::nullopt;
}

void mergeModelsDev(ModelsDevEntry *merged, const ModelsDevEntry &entry,
                    const QHash<QString, int> &trueCount, const QHash<QString, int> &falseCount,
                    const QString &key)
{
    if (merged->contextWindow == 0) merged->contextWindow = entry.contextWindow;
    if (merged->maxTokens == 0) merged->maxTokens = entry.maxTokens;
    if (entry.reasoning.value_or(false)) merged->reasoning = true;
    if (entry.toolCall.value_or(false)) merged->toolCall = true;
    merged->attachment = consensusAttachment(trueCount, falseCount, key, entry);
    merged->inputModalities = mergedModalities(merged->inputModalities, entry.inputModalities);
    // Modalities must agree with the (conservative) attachment bit, otherwise a minority
    // vendor could advertise image input for a text-only model.
    if (merged->attachment != std::optional<bool>(true)) {
        merged->inputModalities.removeAll(QStringLiteral("image"));
        merged->inputModalities.removeAll(QStringLiteral("video"));
    }
}

QStringList parseModalities(const QVariant &value)
{
    QStringList modalities;
    if (value.isNull()) return modalities;
    const QJsonDocument document = QJsonDocument::fromJson(value.toString().toUtf8());
    if (!document.isArray()) return modalities;
    for (const QJsonValue &item : document.array()) {
        if (item.isString()) modalities.append(item.toString());
    }
    return modalities;
}

qint64 positiveOrZero(const QVariant &value)
{
    if (value.isNull()) return 0;
    bool ok = false;
    const qint64 parsed = value.toLongLong(&ok);
    return ok && parsed > 0 ? parsed : 0;
}

std::optional<bool> flagOrNull(const QVariant &value)
{
    if (value.isNull()) return std::nullopt;
    bool ok = false;
    const qint64 parsed = value.toLongLong(&ok);
    if (!ok) return std::nullopt;
    return parsed == 1;
}

/** Read every row plus the metadata table; an unreadable database yields an empty index. */
bool readRows(const QString &dbPath, QList<OpenRouterEntry> *openrouter,
              QList<ModelsDevEntry> *modelsDev, int *rowCount)
{
    const QString connectionName = QStringLiteral("pideck-model-specs");
    bool opened = false;
    {
        QSqlDatabase database = QSqlDatabase::addDatabase(QStringLiteral("QSQLITE"), connectionName);
        database.setDatabaseName(dbPath);
        database.setConnectOptions(QStringLiteral("QSQLITE_OPEN_READONLY"));
        if (database.open()) {
            opened = true;
            {
                QSqlQuery query(database);
                if (query.exec(QStringLiteral("SELECT source, provider, id, context_window, "
                                              "max_tokens, reasoning, tool_call, attachment, "
                                              "input_modalities FROM model_specs"))) {
                    while (query.next()) {
                        ++(*rowCount);
                        const QString source = query.value(0).toString();
                        const QString id = query.value(2).toString();
                        if (id.isEmpty()) continue;
                        const QStringList modalities = parseModalities(query.value(8));
                        if (source == QStringLiteral("openrouter")) {
                            const qint64 contextWindow = positiveOrZero(query.value(3));
                            if (contextWindow <= 0) continue;
                            openrouter->append(OpenRouterEntry{
                                id, contextWindow, positiveOrZero(query.value(4)), modalities});
                            continue;
                        }
                        if (source != QStringLiteral("models-dev")
                            && source != QStringLiteral("builtin")) {
                            continue;
                        }
                        ModelsDevEntry entry;
                        entry.provider =
                            query.value(1).isNull() ? QString() : query.value(1).toString();
                        entry.id = id;
                        entry.source = source;
                        entry.contextWindow = positiveOrZero(query.value(3));
                        entry.maxTokens = positiveOrZero(query.value(4));
                        entry.reasoning = flagOrNull(query.value(5));
                        entry.toolCall = flagOrNull(query.value(6));
                        entry.attachment = flagOrNull(query.value(7));
                        entry.inputModalities = modalities;
                        modelsDev->append(entry);
                    }
                }
            }
            database.close();
        }
    }
    QSqlDatabase::removeDatabase(connectionName);
    return opened;
}

Index buildIndex(const QString &dbPath)
{
    Index index;
    index.knownProviders = knownProviderAliases();
    if (!QFileInfo::exists(dbPath)) return index;

    QList<OpenRouterEntry> openrouter;
    QList<ModelsDevEntry> modelsDev;
    if (!readRows(dbPath, &openrouter, &modelsDev, &index.rowCount)) return index;

    for (const OpenRouterEntry &entry : openrouter) {
        index.openrouterById.insert(entry.id, entry);
        putLowerOpenRouter(&index.openrouterByIdLower, entry.id.toLower(), entry);
        const int slash = entry.id.lastIndexOf(QLatin1Char('/'));
        const QString tail = slash >= 0 ? entry.id.mid(slash + 1) : entry.id;
        index.openrouterByTail[tail].append(entry);
        index.openrouterByTailLower[tail.toLower()].append(entry);
        const int prefixSlash = entry.id.indexOf(QLatin1Char('/'));
        if (prefixSlash > 0) index.knownProviders.insert(entry.id.left(prefixSlash));
    }

    QHash<QString, int> attachmentTrue;
    QHash<QString, int> attachmentFalse;
    for (const ModelsDevEntry &entry : modelsDev) {
        for (const QString &key : {entry.id, entry.id.toLower()}) {
            if (entry.attachment == std::optional<bool>(true)) attachmentTrue[key] += 1;
            else if (entry.attachment == std::optional<bool>(false)) attachmentFalse[key] += 1;
        }
        index.knownProviders.insert(entry.provider);
    }
    for (const ModelsDevEntry &entry : modelsDev) {
        // Index limits before merging vendors, so a stripped ID cannot borrow another vendor's limit.
        if (!entry.provider.isEmpty() && entry.maxTokens > 0) {
            const QString key = (entry.provider + QLatin1Char('/') + entry.id).toLower();
            if (!index.modelsDevOutputByQualifiedId.contains(key)) {
                index.modelsDevOutputByQualifiedId.insert(key, entry.maxTokens);
            }
        }
        const auto existing = index.modelsDevById.find(entry.id);
        if (existing == index.modelsDevById.end()) {
            index.modelsDevById.insert(entry.id, entry);
        } else {
            mergeModelsDev(&existing.value(), entry, attachmentTrue, attachmentFalse, entry.id);
        }
        const QString lower = entry.id.toLower();
        const auto lowerExisting = index.modelsDevByIdLower.find(lower);
        if (lowerExisting == index.modelsDevByIdLower.end()) {
            index.modelsDevByIdLower.insert(lower, entry);
        } else {
            mergeModelsDev(&lowerExisting.value(), entry, attachmentTrue, attachmentFalse, lower);
        }
    }

    // The contains fallback must run over the merged entries: a minority raw row would
    // otherwise make the image capability depend on row order.
    index.openrouterContains = openrouter;
    std::stable_sort(index.openrouterContains.begin(), index.openrouterContains.end(),
                     [](const OpenRouterEntry &left, const OpenRouterEntry &right) {
                         return left.id.size() > right.id.size();
                     });
    for (const ModelsDevEntry &entry : index.modelsDevById) index.modelsDevContains.append(entry);
    std::stable_sort(index.modelsDevContains.begin(), index.modelsDevContains.end(),
                     [](const ModelsDevEntry &left, const ModelsDevEntry &right) {
                         return left.id.size() > right.id.size();
                     });
    index.loaded = true;
    return index;
}

QString stripProviderPrefix(const QString &id, const QSet<QString> &knownProviders)
{
    const int slash = id.indexOf(QLatin1Char('/'));
    if (slash <= 0) return id;
    const QString prefix = id.left(slash);
    return knownProviders.contains(prefix) ? id.mid(slash + 1) : id;
}

template <typename Entry>
const Entry *findLongestContains(const QList<Entry> &list, const QString &needleLower)
{
    if (needleLower.isEmpty()) return nullptr;
    for (const Entry &entry : list) {
        const QString idLower = entry.id.toLower();
        if (idLower.contains(needleLower) || needleLower.contains(idLower)) return &entry;
    }
    return nullptr;
}

} // namespace

QJsonValue lookup(const QString &resourcesDir, const QString &providerName, const QString &modelId)
{
    const QString trimmed = modelId.trimmed();
    if (trimmed.isEmpty()) return QJsonValue(QJsonValue::Null);
    const QString dbPath = QDir(resourcesDir).filePath(QStringLiteral("model-specs.db"));

    QMutexLocker locker(&cacheMutex());
    auto found = cache().find(dbPath);
    if (found == cache().end()) found = cache().insert(dbPath, buildIndex(dbPath));
    const Index &index = found.value();
    if (!index.loaded) return QJsonValue(QJsonValue::Null);

    const OpenRouterEntry *orEntry = nullptr;
    const auto byFullId = index.openrouterById.constFind(providerName + QLatin1Char('/') + trimmed);
    if (byFullId != index.openrouterById.constEnd()) orEntry = &byFullId.value();
    if (!orEntry) {
        const auto byId = index.openrouterById.constFind(trimmed);
        if (byId != index.openrouterById.constEnd()) orEntry = &byId.value();
    }
    if (!orEntry) {
        const auto byLower = index.openrouterByIdLower.constFind(trimmed.toLower());
        if (byLower != index.openrouterByIdLower.constEnd()) orEntry = &byLower.value();
    }
    const QString trimmedLower = trimmed.toLower();
    // Use verified aliases, including bare IDs exposed by relays. A different
    // explicit vendor prefix is not evidence that its model is the same one.
    if (!orEntry) {
        static const QHash<QString, QString> aliases{
            {QStringLiteral("claude-sonnet-4-5-20250929"), QStringLiteral("anthropic/claude-sonnet-4.5")},
            {QStringLiteral("claude-sonnet-4-5"), QStringLiteral("anthropic/claude-sonnet-4.5")},
            {QStringLiteral("claude-sonnet-4-6"), QStringLiteral("anthropic/claude-sonnet-4.6")},
        };
        const QString anthropicPrefix = QStringLiteral("anthropic/");
        const QString aliasKey = trimmedLower.startsWith(anthropicPrefix)
            ? trimmedLower.mid(anthropicPrefix.size()) : trimmedLower;
        const QString target = trimmedLower == QStringLiteral("google/gemini-flash-latest")
            ? QStringLiteral("~google/gemini-flash-latest") : aliases.value(aliasKey);
        if (!target.isEmpty()) {
            const auto alias = index.openrouterById.constFind(target);
            if (alias != index.openrouterById.constEnd()) orEntry = &alias.value();
        }
    }
    const OpenRouterEntry *orTailEntry = nullptr;
    if (!orEntry && !trimmed.contains(QLatin1Char('/'))) {
        const auto tail = index.openrouterByTail.constFind(trimmed);
        if (tail != index.openrouterByTail.constEnd() && !tail.value().isEmpty()) {
            orTailEntry = &tail.value().first();
        } else {
            const auto tailLower = index.openrouterByTailLower.constFind(trimmed.toLower());
            if (tailLower != index.openrouterByTailLower.constEnd()
                && !tailLower.value().isEmpty()) {
                orTailEntry = &tailLower.value().first();
            }
        }
    }

    const QString mdId = stripProviderPrefix(trimmed, index.knownProviders);
    const ModelsDevEntry *mdEntry = nullptr;
    for (const QString &key : {mdId, trimmed}) {
        const auto entry = index.modelsDevById.constFind(key);
        if (entry != index.modelsDevById.constEnd()) {
            mdEntry = &entry.value();
            break;
        }
    }
    if (!mdEntry) {
        for (const QString &key : {mdId.toLower(), trimmed.toLower()}) {
            const auto entry = index.modelsDevByIdLower.constFind(key);
            if (entry != index.modelsDevByIdLower.constEnd()) {
                mdEntry = &entry.value();
                break;
            }
        }
    }

    const OpenRouterEntry *orContains = findLongestContains(index.openrouterContains, trimmedLower);
    if (!orContains) {
        orContains = findLongestContains(index.openrouterContains,
                                        (providerName + QLatin1Char('/') + trimmed).toLower());
    }
    const ModelsDevEntry *mdContains = findLongestContains(index.modelsDevContains, mdId.toLower());
    if (!mdContains) mdContains = findLongestContains(index.modelsDevContains, trimmedLower);

    const OpenRouterEntry *orResolved = orEntry ? orEntry : (orTailEntry ? orTailEntry : orContains);
    if (!orResolved && !mdEntry && !mdContains) return QJsonValue(QJsonValue::Null);

    QJsonObject spec;
    spec.insert(QStringLiteral("source"),
                orResolved ? QStringLiteral("openrouter") : QStringLiteral("models-dev"));
    spec.insert(QStringLiteral("matchedId"),
                orResolved ? orResolved->id : (mdEntry ? mdEntry->id : mdContains->id));

    qint64 contextWindow = orResolved ? orResolved->contextWindow : 0;
    const qint64 mdContext =
        mdEntry ? mdEntry->contextWindow : (mdContains ? mdContains->contextWindow : 0);
    if (contextWindow == 0) contextWindow = mdContext;
    // A substring hit is not enough to set a persisted output limit for a different model.
    const OpenRouterEntry *orIdentity = orEntry ? orEntry : orTailEntry;
    qint64 maxTokens = orIdentity ? orIdentity->maxTokens : 0;
    if (maxTokens == 0 && !trimmed.contains(QLatin1Char('/'))) {
        if (mdEntry) maxTokens = mdEntry->maxTokens;
    } else if (maxTokens == 0) {
        // An exact qualified catalog ID is valid even when listed by a reseller.
        const auto qualified = index.modelsDevById.constFind(trimmed);
        const auto qualifiedLower = index.modelsDevByIdLower.constFind(trimmedLower);
        if (qualified != index.modelsDevById.constEnd()) maxTokens = qualified.value().maxTokens;
        else if (qualifiedLower != index.modelsDevByIdLower.constEnd()) maxTokens = qualifiedLower.value().maxTokens;
        if (maxTokens == 0) maxTokens = index.modelsDevOutputByQualifiedId.value(trimmedLower);
    }
    if (contextWindow > 0) spec.insert(QStringLiteral("contextWindow"), double(contextWindow));
    if (maxTokens > 0) spec.insert(QStringLiteral("maxTokens"), double(maxTokens));

    const auto hasImage = [](const QStringList &modalities) {
        return modalities.contains(QStringLiteral("image"));
    };
    const bool images = (orResolved && hasImage(orResolved->inputModalities))
        || (mdEntry && hasImage(mdEntry->inputModalities))
        || (mdContains && hasImage(mdContains->inputModalities))
        || (mdEntry && mdEntry->attachment == std::optional<bool>(true))
        || (mdContains && mdContains->attachment == std::optional<bool>(true));
    if (images) spec.insert(QStringLiteral("images"), true);
    if ((mdEntry && mdEntry->reasoning == std::optional<bool>(true))
        || (mdContains && mdContains->reasoning == std::optional<bool>(true))) {
        spec.insert(QStringLiteral("reasoning"), true);
    }
    return spec;
}

int loadedRowCount()
{
    QMutexLocker locker(&cacheMutex());
    int total = 0;
    for (const Index &index : cache()) total += index.rowCount;
    return total;
}

void resetCache()
{
    QMutexLocker locker(&cacheMutex());
    cache().clear();
}

} // namespace modelspecs
