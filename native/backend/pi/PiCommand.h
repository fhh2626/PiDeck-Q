#pragma once

#include <QJsonObject>
#include <QProcessEnvironment>
#include <QString>
#include <QStringList>

/**
 * pi command resolution for the backend's own auxiliary pi processes.
 *
 * Subset of src/main/pi/PiLocator.ts covering what the git AI commit-message
 * generator needs: the user's explicit path, the WSL launch form, the runtime
 * preference path, and a PATH search with the runtime-specific binary names. The
 * full locator (version probe, compatible CLI flags, login-shell PATH discovery) belongs to
 * the pi runtime stage.
 */
namespace picommand {

struct Invocation {
    QString program;
    QStringList arguments;
    bool viaWsl = false;
};

Invocation resolve(const QJsonObject &settings);

/** Sanitized child environment with the resolved PATH for this invocation. */
QProcessEnvironment environment(const QJsonObject &settings, const Invocation &invocation);

} // namespace picommand
