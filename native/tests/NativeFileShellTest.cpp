#include "../src/NativeFileShell.h"
#include <QCoreApplication>
#include <QDir>
#include <QFile>
#include <QTemporaryDir>
#include <QUrl>
#include <iostream>

/** Exercise the production shell routing without launching a desktop application. */
int main(int argc, char **argv)
{
    QCoreApplication app(argc, argv);
    QTemporaryDir fixture;
    if (!fixture.isValid()) return 1;
    const QString folder = fixture.filePath(QStringLiteral("directory with spaces, %20.md"));
    if (!QDir().mkpath(folder)) return 1;
    QUrl opened;
    const auto capture = [&opened](const QUrl &url) { opened = url; return true; };
    auto result = revealNativeFile(folder, capture);
    if (!result.value(QStringLiteral("ok")).toBool() || opened.toLocalFile() != folder) {
        std::cerr << "A directory must open itself, including literal percent signs and file-like names\n";
        return 1;
    }
    result = revealNativeFile(folder, [](const QUrl &) { return false; });
    if (result.value(QStringLiteral("ok")).toBool() || result.value(QStringLiteral("error")).toString().isEmpty()) {
        std::cerr << "A file-manager launch failure must be returned to the renderer\n";
        return 1;
    }
    opened = QUrl{};
    result = revealNativeFile(fixture.filePath(QStringLiteral("missing")), capture);
    if (result.value(QStringLiteral("ok")).toBool() || !opened.isEmpty()) {
        std::cerr << "A missing path must not launch any application\n";
        return 1;
    }
#ifndef Q_OS_WIN
    const QString filePath = QDir(folder).filePath(QStringLiteral("file.txt"));
    QFile file(filePath);
    if (!file.open(QIODevice::WriteOnly)) return 1;
    file.close();
    result = revealNativeFile(filePath, capture);
    if (!result.value(QStringLiteral("ok")).toBool() || opened.toLocalFile() != folder) {
        std::cerr << "A file must reveal its containing directory\n";
        return 1;
    }
#endif
    return 0;
}
