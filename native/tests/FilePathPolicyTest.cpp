#include "PathPolicy.h"
#include "WslFilePaths.h"
#include "../backend/domain/runtime/ProjectionFilePath.h"

#include <QCoreApplication>
#include <QElapsedTimer>
#include <QFile>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QThread>

#include <cstdio>

/** Invoke the production file mapper and path policy for cross-platform regression fixtures. */
int main(int argc, char **argv)
{
    QCoreApplication app(argc, argv);
    QFile input;
    if (!input.open(stdin, QIODevice::ReadOnly)) return 1;
    QJsonParseError error;
    const QJsonDocument document = QJsonDocument::fromJson(input.readAll(), &error);
    if (error.error != QJsonParseError::NoError || !document.isObject()) return 2;
    const QJsonObject fixture = document.object();
    QJsonArray mappings;
    for (const QJsonValue &value : fixture.value(QStringLiteral("mappings")).toArray()) {
        const QJsonObject entry = value.toObject();
        mappings.append(wsl::toWindowsFilePath(entry.value(QStringLiteral("path")).toString(),
            entry.value(QStringLiteral("enabled")).toBool(), entry.value(QStringLiteral("distro")).toString()));
    }
    QJsonArray containment;
    for (const QJsonValue &value : fixture.value(QStringLiteral("containment")).toArray()) {
        const QJsonObject entry = value.toObject();
        containment.append(pathpolicy::isPathInsideRoot(entry.value(QStringLiteral("target")).toString(),
                                                       entry.value(QStringLiteral("root")).toString()));
    }
    QJsonArray projectionPaths;
    for (const QJsonValue &value : fixture.value(QStringLiteral("projectionPaths")).toArray()) {
        const QJsonObject entry = value.toObject();
        projectionPaths.append(runtime::projectionFilePath(entry.value(QStringLiteral("path")).toString(),
            entry.value(QStringLiteral("environment")).toString(), entry.value(QStringLiteral("distro")).toString(),
            entry.value(QStringLiteral("windowsHost")).toBool()));
    }
    QJsonArray authorizations;
    for (const QJsonValue &value : fixture.value(QStringLiteral("authorizations")).toArray()) {
        const QJsonObject entry = value.toObject();
        QStringList roots;
        for (const QJsonValue &root : entry.value(QStringLiteral("roots")).toArray()) roots.append(root.toString());
        const QString modeName = entry.value(QStringLiteral("mode")).toString();
        const pathpolicy::Mode mode = modeName == QLatin1String("link") ? pathpolicy::Mode::Link
            : modeName == QLatin1String("write") ? pathpolicy::Mode::Write : pathpolicy::Mode::Read;
        QJsonArray rootProbes;
        const auto probe = [&entry, &rootProbes](const QString &root) {
            rootProbes.append(root);
            if (root == entry.value(QStringLiteral("slowRoot")).toString()) {
                QThread::msleep(qMax(0, entry.value(QStringLiteral("rootDelayMs")).toInt()));
            }
            return pathpolicy::existingRealPath(root);
        };
        QElapsedTimer timer;
        timer.start();
        const pathpolicy::Result result = pathpolicy::assertAuthorized(
            entry.value(QStringLiteral("target")).toString(), roots, modeName, mode, probe);
        authorizations.append(QJsonObject{{QStringLiteral("ok"), result.ok},
            {QStringLiteral("path"), result.path}, {QStringLiteral("error"), result.error},
            {QStringLiteral("rootProbes"), rootProbes}, {QStringLiteral("elapsedMs"), timer.elapsed()}});
    }
    const QByteArray output = QJsonDocument(QJsonObject{{QStringLiteral("mappings"), mappings},
                                                       {QStringLiteral("projectionPaths"), projectionPaths},
                                                       {QStringLiteral("authorizations"), authorizations},
                                                       {QStringLiteral("containment"), containment}})
                                  .toJson(QJsonDocument::Compact);
    std::fwrite(output.constData(), 1, size_t(output.size()), stdout);
    std::fputc('\n', stdout);
    return 0;
}
