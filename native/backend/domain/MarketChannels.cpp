#include "ChannelContext.h"

#include "market/HttpClient.h"
#include "market/XuePrompts.h"
#include "prompts/PromptManager.h"

#include <QHash>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QRegularExpression>
#include <QUrl>
#include <QUrlQuery>

/**
 * `prompt-store:*` (prompts.chat) and `yao-prompts:*` (bundled SQLite library).
 *
 * Port of the corresponding half of src/main/ipc/storeIpc.ts. The remote endpoints are
 * untrusted: every response is parsed defensively, every request has a hard deadline,
 * and a failure is reported as the oracle's localized copy instead of an empty list.
 */
namespace {

constexpr int kPromptStoreTimeoutMs = 10'000;

QString endpoint(const ChannelServices &services, const QString &key, const QString &fallback)
{
    const QJsonObject overrides = services.marketEndpoints;
    const QString value = overrides.value(key).toString();
    return value.isEmpty() ? fallback : value;
}

/** `flattenPromptItem`: the raw API record reduced to what the UI renders. */
QJsonObject flattenPromptItem(const QJsonObject &raw)
{
    QJsonArray tags;
    for (const QJsonValue &tag : raw.value(QStringLiteral("tags")).toArray()) {
        const QString name = tag.toObject().value(QStringLiteral("tag")).toObject()
                                 .value(QStringLiteral("name")).toString();
        if (!name.isEmpty()) tags.append(name);
    }
    QJsonObject item{
        {QStringLiteral("id"), raw.value(QStringLiteral("id")).toString()},
        {QStringLiteral("title"), raw.value(QStringLiteral("title")).toString()},
        {QStringLiteral("description"), raw.value(QStringLiteral("description")).toString()},
        {QStringLiteral("content"), raw.value(QStringLiteral("content")).toString()},
        {QStringLiteral("type"), raw.value(QStringLiteral("type")).toString()},
        {QStringLiteral("author"), raw.value(QStringLiteral("author")).toObject()
                                       .value(QStringLiteral("name")).toString()},
        {QStringLiteral("category"), raw.value(QStringLiteral("category")).toObject()
                                         .value(QStringLiteral("name")).toString()},
        {QStringLiteral("tags"), tags},
        {QStringLiteral("votes"), raw.value(QStringLiteral("voteCount")).toInt(0)},
    };
    // `createdAt` is optional in the API; an absent value must stay absent.
    const QJsonValue createdAt = raw.value(QStringLiteral("createdAt"));
    if (!createdAt.isUndefined()) item.insert(QStringLiteral("createdAt"), createdAt);
    return item;
}

struct Converted {
    QString converted;
    QString argumentHint;
    int variableCount = 0;
};

/**
 * `convertStoreVarsToPiVars`: prompts.chat uses `${name}` / `${name:default}`, pi uses
 * positional `$1` / `${1:-default}`. The first appearance of a name fixes its index.
 */
Converted convertStoreVars(const QString &content)
{
    static const QRegularExpression pattern(QStringLiteral("\\$\\{([a-zA-Z_]\\w*)(?::(.*?))?\\}"));
    struct Info {
        int index = 0;
        bool hasDefault = false;
        QString defaultVal;
    };
    QHash<QString, Info> variables;
    QStringList order;
    int nextIndex = 1;
    auto iterator = pattern.globalMatch(content);
    while (iterator.hasNext()) {
        const QRegularExpressionMatch match = iterator.next();
        const QString name = match.captured(1);
        if (variables.contains(name)) continue;
        Info info;
        info.index = nextIndex++;
        info.hasDefault = match.capturedStart(2) >= 0;
        info.defaultVal = match.captured(2);
        variables.insert(name, info);
        order.append(name);
    }

    Converted result;
    if (variables.isEmpty()) {
        result.converted = content;
        return result;
    }
    QString converted;
    int last = 0;
    iterator = pattern.globalMatch(content);
    while (iterator.hasNext()) {
        const QRegularExpressionMatch match = iterator.next();
        converted += content.mid(last, match.capturedStart() - last);
        const Info info = variables.value(match.captured(1));
        if (match.capturedStart(2) >= 0) {
            converted += QStringLiteral("${%1:-%2}").arg(info.index).arg(match.captured(2));
        } else {
            converted += QStringLiteral("$%1").arg(info.index);
        }
        last = match.capturedEnd();
    }
    converted += content.mid(last);

    QStringList hints;
    for (int index = 1; index < nextIndex; ++index) {
        for (auto it = variables.constBegin(); it != variables.constEnd(); ++it) {
            if (it.value().index != index) continue;
            hints.append(it.value().hasDefault
                             ? QStringLiteral("[%1:%2]").arg(it.key(), it.value().defaultVal)
                             : QStringLiteral("<%1>").arg(it.key()));
            break;
        }
    }
    result.converted = converted;
    result.argumentHint = hints.join(QLatin1Char(' '));
    result.variableCount = variables.size();
    return result;
}

/** `normalizeName`: Unicode letters/digits/hyphens, collapsed, lowercased. */
QString slugName(const QString &value)
{
    QString name = value.trimmed().toLower();
    static const QRegularExpression disallowed(QStringLiteral("[^\\p{L}\\p{N}-]+"));
    name.replace(disallowed, QStringLiteral("-"));
    static const QRegularExpression repeated(QStringLiteral("-+"));
    name.replace(repeated, QStringLiteral("-"));
    while (name.startsWith(QLatin1Char('-'))) name.remove(0, 1);
    while (name.endsWith(QLatin1Char('-'))) name.chop(1);
    return name;
}

QString localized(const ChannelServices &services, const QString &key)
{
    return services.translate ? services.translate(key, QJsonObject{}) : key;
}

QJsonObject parseObject(const markethttp::Response &response)
{
    const QJsonDocument document = QJsonDocument::fromJson(response.body);
    return document.isObject() ? document.object() : QJsonObject{};
}

} // namespace

void registerSkillMarketChannels(ChannelRegistry &registry, ChannelServices &services);

void registerPromptMarketChannels(ChannelRegistry &registry, ChannelServices &services)
{
    registry.addAsync(QStringLiteral("prompt-store:search"),
                      [&services](const QJsonArray &args, ChannelResponder responder) {
                          const QString query = channels::stringArg(args, 0);
                          const QJsonObject options = channels::objectArg(args, 1);
                          QUrl url(endpoint(services, QStringLiteral("promptStore"),
                                            QStringLiteral("https://prompts.chat/api"))
                                   + QStringLiteral("/prompts"));
                          QUrlQuery params;
                          params.addQueryItem(QStringLiteral("q"), query);
                          const int limit = options.value(QStringLiteral("limit")).toInt(0);
                          if (limit > 0) {
                              params.addQueryItem(QStringLiteral("perPage"), QString::number(limit));
                          }
                          for (const QString &key : {QStringLiteral("type"), QStringLiteral("category"),
                                                     QStringLiteral("tag")}) {
                              const QString value = options.value(key).toString();
                              if (!value.isEmpty()) params.addQueryItem(key, value);
                          }
                          url.setQuery(params);
                          markethttp::get(url, kPromptStoreTimeoutMs,
                                          [&services, query, responder](
                                              const markethttp::Response &response) mutable {
                                              if (!response.ok()) {
                                                  responder.reject(localized(
                                                      services,
                                                      QStringLiteral("store.promptSearchFailed")));
                                                  return;
                                              }
                                              const QJsonObject raw = parseObject(response);
                                              QJsonArray prompts;
                                              for (const QJsonValue &item :
                                                   raw.value(QStringLiteral("prompts")).toArray()) {
                                                  prompts.append(flattenPromptItem(item.toObject()));
                                              }
                                              responder.resolve(QJsonValue(QJsonObject{
                                                  {QStringLiteral("query"), query},
                                                  {QStringLiteral("count"),
                                                   raw.value(QStringLiteral("total")).toInt(0)},
                                                  {QStringLiteral("prompts"), prompts},
                                              }));
                                          });
                      });

    registry.addAsync(QStringLiteral("prompt-store:get"),
                      [&services](const QJsonArray &args, ChannelResponder responder) {
                          const QString id = channels::stringArg(args, 0);
                          const QUrl url(endpoint(services, QStringLiteral("promptStore"),
                                                  QStringLiteral("https://prompts.chat/api"))
                                         + QStringLiteral("/prompts/")
                                         + QString::fromLatin1(QUrl::toPercentEncoding(id)));
                          markethttp::get(url, kPromptStoreTimeoutMs,
                                          [&services, responder](
                                              const markethttp::Response &response) mutable {
                                              if (!response.ok()) {
                                                  responder.reject(localized(
                                                      services,
                                                      QStringLiteral("store.promptDetailFailed")));
                                                  return;
                                              }
                                              responder.resolve(QJsonValue(
                                                  flattenPromptItem(parseObject(response))));
                                          });
                      });

    registry.add(QStringLiteral("prompt-store:import"), [&services](const QJsonArray &args) {
        const QJsonObject input = channels::objectArg(args, 0);
        const QString title = input.value(QStringLiteral("title")).toString();
        const QString description = input.value(QStringLiteral("description")).toString();
        const QString content = input.value(QStringLiteral("content")).toString();
        if (!services.prompts) throw ChannelError(QStringLiteral("Prompt manager is not available"));
        const QString name = slugName(title);
        if (name.isEmpty()) {
            throw ChannelError(localized(services, QStringLiteral("store.invalidItemTitle")));
        }
        const Converted converted = convertStoreVars(content);
        const QString hintLine = converted.argumentHint.isEmpty()
            ? QString()
            : QStringLiteral("\nargument-hint: %1").arg(converted.argumentHint);
        const QString frontmatter =
            QStringLiteral("---\ndescription: %1\nsource: prompts.chat%2\n---\n\n")
                .arg(QString(description).replace(QLatin1Char('\n'), QLatin1Char(' ')), hintLine);
        // Same bounded retry as createUniquePrompt: only a name collision retries.
        QString candidate = name;
        prompttpl::Template created;
        for (int attempt = 0; attempt < 32; ++attempt) {
            try {
                created = services.prompts->create(candidate, description);
                break;
            } catch (const std::exception &failure) {
                const QString message = QString::fromUtf8(failure.what());
                if (!message.contains(QLatin1String("already exists")) || attempt == 31) {
                    throw ChannelError(localized(services,
                                                 QStringLiteral("store.promptImportFailed")));
                }
                static const QRegularExpression trailing(QStringLiteral("-(\\d+)$"));
                const QRegularExpressionMatch match = trailing.match(candidate);
                const int next = match.hasMatch() ? match.captured(1).toInt() + 1 : 2;
                QString stem = candidate;
                stem.remove(trailing);
                if (stem.isEmpty()) stem = name;
                candidate = QStringLiteral("%1-%2").arg(stem).arg(next);
            }
        }
        services.prompts->writeContent(created.path, frontmatter + converted.converted);
        return QJsonValue(prompttpl::toJson(created));
    });

    registry.addAsync(QStringLiteral("yao-prompts:list"),
                      [&services](const QJsonArray &args, ChannelResponder responder) {
                          if (!services.xuePrompts) {
                              responder.reject(QStringLiteral("Prompt library is not available"));
                              return;
                          }
                          const bool hasOptions = channels::argAt(args, 0).isObject();
                          const QJsonObject options = channels::objectArg(args, 0);
                          const xueprompts::Result result = services.xuePrompts->list(
                              hasOptions, options.value(QStringLiteral("category")).toString(),
                              options.value(QStringLiteral("search")).toString(),
                              options.value(QStringLiteral("page")).toInt(1),
                              options.value(QStringLiteral("pageSize")).toInt(20));
                          if (!result.ok) {
                              responder.reject(localized(services,
                                                         QStringLiteral("store.yaoListFailed")));
                              return;
                          }
                          responder.resolve(QJsonValue(result.value));
                      });

    registry.addAsync(QStringLiteral("yao-prompts:detail"),
                      [&services](const QJsonArray &args, ChannelResponder responder) {
                          if (!services.xuePrompts) {
                              responder.reject(QStringLiteral("Prompt library is not available"));
                              return;
                          }
                          const QString slug = channels::stringArg(args, 0);
                          const xueprompts::Result result = services.xuePrompts->detail(slug);
                          if (!result.ok || result.value.isEmpty()) {
                              responder.reject(localized(services,
                                                         QStringLiteral("store.yaoDetailFailed")));
                              return;
                          }
                          responder.resolve(QJsonValue(result.value));
                      });

    registry.add(QStringLiteral("yao-prompts:import"), [&services](const QJsonArray &args) {
        if (!services.xuePrompts || !services.prompts) {
            throw ChannelError(QStringLiteral("Prompt library is not available"));
        }
        const QString slug = channels::stringArg(args, 0);
        const xueprompts::Result detail = services.xuePrompts->detail(slug);
        if (!detail.ok || detail.value.isEmpty()) {
            throw ChannelError(localized(services, QStringLiteral("store.yaoImportFailed")));
        }
        const QString title = detail.value.value(QStringLiteral("title")).toString();
        const QString description = detail.value.value(QStringLiteral("description")).toString();
        const QString promptContent = detail.value.value(QStringLiteral("promptContent")).toString();
        const QString name = slugName(slug);
        const QString effectiveDescription = description.isEmpty() ? title : description;

        QString candidate = name;
        prompttpl::Template created;
        for (int attempt = 0; attempt < 32; ++attempt) {
            try {
                created = services.prompts->create(candidate, effectiveDescription);
                break;
            } catch (const std::exception &failure) {
                const QString message = QString::fromUtf8(failure.what());
                if (!message.contains(QLatin1String("already exists")) || attempt == 31) {
                    throw ChannelError(localized(services, QStringLiteral("store.yaoImportFailed")));
                }
                static const QRegularExpression trailing(QStringLiteral("-(\\d+)$"));
                const QRegularExpressionMatch match = trailing.match(candidate);
                const int next = match.hasMatch() ? match.captured(1).toInt() + 1 : 2;
                QString stem = candidate;
                stem.remove(trailing);
                if (stem.isEmpty()) stem = name;
                candidate = QStringLiteral("%1-%2").arg(stem).arg(next);
            }
        }
        const QString frontmatter =
            QStringLiteral("---\ndescription: %1\nsource: xueprompt\n---\n\n")
                .arg(QString(effectiveDescription).replace(QLatin1Char('\n'), QLatin1Char(' ')));
        services.prompts->writeContent(created.path, frontmatter + promptContent);
        return QJsonValue(prompttpl::toJson(created));
    });
}
