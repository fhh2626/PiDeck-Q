#include "WindowState.h"

#include <QDir>
#include <QFile>
#include <QJsonDocument>
#include <QSaveFile>

namespace {

constexpr double kMinimumWidth = 880;
constexpr double kMinimumHeight = 640;

bool isFiniteNumber(const QJsonValue &value)
{
    return value.isDouble();
}

} // namespace

namespace windowstate {

QJsonObject readLastWindowBounds(const QString &userDataDir)
{
    QFile file(QDir(userDataDir).filePath(QStringLiteral("last-window-bounds.json")));
    if (!file.open(QIODevice::ReadOnly)) return {};
    const QJsonDocument document = QJsonDocument::fromJson(file.readAll());
    if (!document.isObject()) return {};
    const QJsonObject parsed = document.object();
    const QJsonValue width = parsed.value(QStringLiteral("width"));
    const QJsonValue height = parsed.value(QStringLiteral("height"));
    if (!isFiniteNumber(width) || !isFiniteNumber(height)) return {};
    if (width.toDouble() < kMinimumWidth || height.toDouble() < kMinimumHeight) return {};

    QJsonObject result{
        {QStringLiteral("width"), qRound(width.toDouble())},
        {QStringLiteral("height"), qRound(height.toDouble())},
    };
    // Treat coordinates as a pair: a partial position must not fabricate a zero.
    if (isFiniteNumber(parsed.value(QStringLiteral("x"))) && isFiniteNumber(parsed.value(QStringLiteral("y")))) {
        result.insert(QStringLiteral("x"), qRound(parsed.value(QStringLiteral("x")).toDouble()));
        result.insert(QStringLiteral("y"), qRound(parsed.value(QStringLiteral("y")).toDouble()));
    }
    return result;
}

void saveLastWindowBounds(const QString &userDataDir, const QJsonObject &bounds)
{
    if (bounds.isEmpty()) return;
    QDir().mkpath(userDataDir);
    QSaveFile file(QDir(userDataDir).filePath(QStringLiteral("last-window-bounds.json")));
    if (!file.open(QIODevice::WriteOnly)) return;
    if (file.write(QJsonDocument(bounds).toJson(QJsonDocument::Compact)) < 0) return;
    file.commit();
}

} // namespace windowstate
