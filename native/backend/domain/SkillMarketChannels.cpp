#include "ChannelContext.h"

#include "extensions/PiCli.h"
#include "market/HttpClient.h"
#include "skills/SkillManager.h"
#include "../process/BackgroundWork.h"

#include <QFile>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QRegularExpression>
#include <QUrl>
#include <QUrlQuery>

#include <algorithm>

/**
 * `skill-store:*` (prompts.chat skills) and `skill-hub:*` (skills.sh).
 *
 * Port of the corresponding half of src/main/ipc/storeIpc.ts. `skill-hub:install` shells
 * out to `npx skills add`, which is the only supported installer for that catalogue; the
 * slug is validated against a shell-safe allowlist *before* it is passed as an argument,
 * and the arguments are handed over as an array (never a shell string).
 */
namespace {

constexpr int kSkillStoreTimeoutMs = 10'000;
constexpr int kSkillHubTimeoutMs = 15'000;
constexpr int kSkillHubInstallTimeoutMs = 120'000;

QString localized(const ChannelServices &services, const QString &key)
{
    return services.translate ? services.translate(key, QJsonObject{}) : key;
}

QString endpoint(const ChannelServices &services, const QString &key, const QString &fallback)
{
    const QString value = services.marketEndpoints.value(key).toString();
    return value.isEmpty() ? fallback : value;
}

QJsonObject parseObject(const markethttp::Response &response)
{
    const QJsonDocument document = QJsonDocument::fromJson(response.body);
    return document.isObject() ? document.object() : QJsonObject{};
}

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
    const QJsonValue createdAt = raw.value(QStringLiteral("createdAt"));
    if (!createdAt.isUndefined()) item.insert(QStringLiteral("createdAt"), createdAt);
    return item;
}

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

} // namespace

void registerPromptMarketChannels(ChannelRegistry &registry, ChannelServices &services);

void registerSkillMarketChannels(ChannelRegistry &registry, ChannelServices &services)
{
    registry.addAsync(QStringLiteral("skill-store:search"),
                      [&services](const QJsonArray &args, ChannelResponder responder) {
                          const QString query = channels::stringArg(args, 0);
                          QUrl url(endpoint(services, QStringLiteral("promptStore"),
                                            QStringLiteral("https://prompts.chat/api"))
                                   + QStringLiteral("/prompts"));
                          QUrlQuery params;
                          params.addQueryItem(QStringLiteral("q"), query);
                          params.addQueryItem(QStringLiteral("perPage"), QStringLiteral("20"));
                          url.setQuery(params);
                          markethttp::get(url, kSkillStoreTimeoutMs,
                                          [&services, query, responder](
                                              const markethttp::Response &response) mutable {
                                              if (!response.ok()) {
                                                  responder.reject(localized(
                                                      services,
                                                      QStringLiteral("store.skillSearchFailed")));
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

    registry.add(QStringLiteral("skill-store:import"), [&services](const QJsonArray &args) {
        if (!services.skills) throw ChannelError(QStringLiteral("Skill manager is not available"));
        const QJsonObject item = channels::objectArg(args, 0);
        const QString locationId = channels::stringArg(args, 1);
        const QString title = item.value(QStringLiteral("title")).toString();
        const QString description = item.value(QStringLiteral("description")).toString();
        const QString content = item.value(QStringLiteral("content")).toString();
        const QString name = slugName(title);
        if (name.isEmpty()) {
            throw ChannelError(localized(services, QStringLiteral("store.invalidItemTitle")));
        }
        const QString effectiveDescription = description.isEmpty() ? title : description;
        skills::Summary created;
        try {
            created = services.skills->create(name, effectiveDescription,
                                              locationId.isEmpty() ? QStringLiteral("pi-global")
                                                                   : locationId);
        } catch (const std::exception &) {
            throw ChannelError(localized(services, QStringLiteral("store.skillImportFailed")));
        }
        const QString skillContent =
            QStringLiteral("---\nname: %1\ndescription: %2\nsource: prompts.chat\n---\n\n# %3\n\n%4")
                .arg(name,
                     QString(effectiveDescription).replace(QLatin1Char('\n'), QLatin1Char(' ')),
                     title, content);
        QFile file(created.path);
        if (!file.open(QIODevice::WriteOnly | QIODevice::Truncate)) {
            throw ChannelError(localized(services, QStringLiteral("store.skillImportFailed")));
        }
        const QByteArray bytes = skillContent.toUtf8();
        if (file.write(bytes) != bytes.size()) {
            throw ChannelError(localized(services, QStringLiteral("store.skillImportFailed")));
        }
        file.close();
        return QJsonValue(skills::summaryToJson(created));
    });

    registry.addAsync(QStringLiteral("skill-hub:search"),
                      [&services](const QJsonArray &args, ChannelResponder responder) {
                          const QJsonObject options = channels::objectArg(args, 0);
                          const QString query = options.value(QStringLiteral("query")).toString();
                          const int limit = options.value(QStringLiteral("limit")).toInt(50);
                          QUrl url(endpoint(services, QStringLiteral("skillHub"),
                                            QStringLiteral("https://www.skills.sh"))
                                   + QStringLiteral("/api/search"));
                          QUrlQuery params;
                          params.addQueryItem(QStringLiteral("q"), query);
                          params.addQueryItem(QStringLiteral("limit"), QString::number(limit));
                          url.setQuery(params);
                          markethttp::get(url, kSkillHubTimeoutMs,
                                          [&services, query, responder](
                                              const markethttp::Response &response) mutable {
                                              if (!response.ok()) {
                                                  responder.reject(localized(
                                                      services,
                                                      QStringLiteral("store.skillsShSearchFailed")));
                                                  return;
                                              }
                                              const QJsonObject raw = parseObject(response);
                                              QJsonArray items;
                                              for (const QJsonValue &value :
                                                   raw.value(QStringLiteral("skills")).toArray()) {
                                                  const QJsonObject skill = value.toObject();
                                                  const int installs =
                                                      skill.value(QStringLiteral("installs")).toInt(0);
                                                  items.append(QJsonObject{
                                                      {QStringLiteral("slug"),
                                                       skill.value(QStringLiteral("id")).toString()},
                                                      {QStringLiteral("name"),
                                                       skill.value(QStringLiteral("name")).toString()},
                                                      {QStringLiteral("description"), QString()},
                                                      {QStringLiteral("description_zh"), QString()},
                                                      {QStringLiteral("stars"), 0},
                                                      {QStringLiteral("downloads"), installs},
                                                      {QStringLiteral("installs"), installs},
                                                      {QStringLiteral("category"), QString()},
                                                      {QStringLiteral("version"), QString()},
                                                      {QStringLiteral("ownerName"),
                                                       skill.value(QStringLiteral("source")).toString()},
                                                      {QStringLiteral("source"),
                                                       QStringLiteral("skills.sh")},
                                                  });
                                              }
                                              // The catalogue is ordered by popularity, which
                                              // the renderer relies on for the default view.
                                              QVector<QJsonObject> sorted;
                                              for (const QJsonValue &value : items) {
                                                  sorted.append(value.toObject());
                                              }
                                              std::stable_sort(
                                                  sorted.begin(), sorted.end(),
                                                  [](const QJsonObject &left, const QJsonObject &right) {
                                                      return left.value(QStringLiteral("installs")).toInt()
                                                          > right.value(QStringLiteral("installs")).toInt();
                                                  });
                                              QJsonArray ordered;
                                              for (const QJsonObject &item : sorted) ordered.append(item);
                                              responder.resolve(QJsonValue(QJsonObject{
                                                  {QStringLiteral("query"), query},
                                                  {QStringLiteral("total"), ordered.size()},
                                                  {QStringLiteral("items"), ordered},
                                              }));
                                          });
                      });

    // The skills.sh catalogue has no per-skill detail endpoint; the oracle answers null.
    registry.add(QStringLiteral("skill-hub:detail"), [](const QJsonArray &) {
        return QJsonValue(QJsonValue::Null);
    });

    registry.addAsync(QStringLiteral("skill-hub:install"),
                      [&services](const QJsonArray &args, ChannelResponder responder) {
                          const QString slug = channels::stringArg(args, 0);
                          const int lastSlash = slug.lastIndexOf(QLatin1Char('/'));
                          const QString package = lastSlash > 0 ? slug.left(lastSlash) : slug;
                          const QString skillName = lastSlash > 0 ? slug.mid(lastSlash + 1) : QString();
                          // Whitelist before the value reaches the installer: this is the
                          // only place a renderer string becomes a process argument.
                          static const QRegularExpression safe(
                              QStringLiteral("^[a-zA-Z0-9@/\\-_.]+$"));
                          if (!safe.match(package).hasMatch()
                              || (!skillName.isEmpty() && !safe.match(skillName).hasMatch())) {
                              responder.resolve(QJsonValue(QJsonObject{
                                  {QStringLiteral("success"), false},
                                  {QStringLiteral("slug"), slug},
                                  {QStringLiteral("installDir"), QString()},
                                  {QStringLiteral("error"),
                                   localized(services,
                                             QStringLiteral("store.skillsShInvalidSlug"))},
                              }));
                              return;
                          }
                          // The installer can run for two minutes, so it must not block
                          // the backend event loop (SSE, host bridge, RPC).
                          background::runBlocking(
                              [package, skillName]() {
                                  const picli::Result result = picli::runCommand(
                                      QStringLiteral("npx"),
                                      QStringList{QStringLiteral("skills"), QStringLiteral("add"),
                                                  package, QStringLiteral("-g"),
                                                  QStringLiteral("-s"), skillName,
                                                  QStringLiteral("-y")},
                                      kSkillHubInstallTimeoutMs);
                                  if (result.ok()) return QJsonValue(QString());
                                  // The renderer shows this text directly, so a truncated
                                  // real message beats a generic "install failed".
                                  QString brief = result.errorMessage();
                                  if (brief.size() > 300) brief = brief.left(300) + QStringLiteral("…");
                                  return QJsonValue(brief);
                              },
                              [slug, responder](background::Outcome outcome) mutable {
                                  if (!outcome.ok) {
                                      responder.reject(outcome.error);
                                      return;
                                  }
                                  const QString error = outcome.value.toString();
                                  QJsonObject payload{
                                      {QStringLiteral("success"), error.isEmpty()},
                                      {QStringLiteral("slug"), slug},
                                      {QStringLiteral("installDir"), QString()},
                                  };
                                  if (!error.isEmpty()) payload.insert(QStringLiteral("error"), error);
                                  responder.resolve(QJsonValue(payload));
                              });
                      });
}

void registerMarketChannels(ChannelRegistry &registry, ChannelServices &services)
{
    registerPromptMarketChannels(registry, services);
    registerSkillMarketChannels(registry, services);
}
