#include "ChildEnvironment.h"

namespace childenv {

QStringList privateKeys()
{
    return {
        QStringLiteral("PIDECK_HOST_TOKEN"),
        QStringLiteral("PIDECK_HOST_PORT"),
        QStringLiteral("PIDECK_NATIVE_HOST"),
        QStringLiteral("PIDECK_RENDERER_ROOT"),
        QStringLiteral("PIDECK_NATIVE_NODE_ENTRY"),
    };
}

QProcessEnvironment sanitized(const QProcessEnvironment &base)
{
    QProcessEnvironment environment = base;
    for (const QString &key : privateKeys()) environment.remove(key);

    const QStringList names = environment.keys();
    for (const QString &key : names) {
        if (key.startsWith(QStringLiteral("ELECTRON_"))) {
            environment.remove(key);
            continue;
        }
        if (key.startsWith(QStringLiteral("CHROME_")) || key.startsWith(QStringLiteral("GOOGLE_API_"))) {
            environment.remove(key);
        }
    }
    // NODE_OPTIONS accepts shell-like quoting and escaped paths. Re-tokenizing it
    // here can corrupt valid arguments, so children receive no inherited Node
    // bootstrap options at all.
    environment.remove(QStringLiteral("NODE_OPTIONS"));
    return environment;
}

bool containsPrivateValue(const QProcessEnvironment &environment)
{
    for (const QString &key : privateKeys()) {
        if (environment.contains(key)) return true;
    }
    if (environment.contains(QStringLiteral("NODE_OPTIONS"))) return true;
    const QStringList names = environment.keys();
    for (const QString &key : names) {
        if (key.startsWith(QStringLiteral("ELECTRON_")) || key.startsWith(QStringLiteral("CHROME_"))
            || key.startsWith(QStringLiteral("GOOGLE_API_"))) {
            return true;
        }
    }
    return false;
}

} // namespace childenv
