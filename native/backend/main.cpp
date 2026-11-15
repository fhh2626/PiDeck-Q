#include "app/BackendApplication.h"
#include "app/BackendEnvironment.h"
#include "app/FocusTargets.h"
#include "app/LifecycleTrace.h"
#include "app/SingleInstance.h"
#include "app/ThreadStackReport.h"
#include "transport/HostRpcClient.h"

#include "BackgroundWork.h"

#include <QCoreApplication>
#include <QDateTime>
#include <QEventLoop>
#include <QJsonValue>
#include <QTimer>

#include <cstdio>
#include <cstdlib>
#include <memory>

namespace {

/**
 * Ask the host to quit this secondary instance and wait (bounded) for its answer.
 *
 * The host owns the window/tray, so a secondary that simply exited would look like a
 * crashed sidecar and be restarted once. `application.exitSecondary` is the oracle's
 * signal that this process was only a launch attempt.
 */
void requestSecondaryExit(HostRpcClient &host)
{
    QEventLoop loop;
    QTimer guard;
    guard.setSingleShot(true);
    QObject::connect(&guard, &QTimer::timeout, &loop, &QEventLoop::quit);
    auto request = host.request(QStringLiteral("application.exitSecondary"));
    request->then([&loop](const QJsonValue &) { loop.quit(); });
    request->fail([&loop](const QString &) { loop.quit(); });
    guard.start(2'000);
    loop.exec(QEventLoop::ExcludeUserInputEvents);
}

} // namespace

/**
 * C++ backend entry point.
 *
 * The process is a child of the Qt host: it connects back over the length-prefixed
 * host bridge, serves the renderer over loopback HTTP/SSE, and exits when the host
 * asks it to. All wiring lives in BackendApplication so this file stays a thin
 * launcher with no business logic.
 *
 * Single-instance ordering matters and mirrors the Node sidecar: connect to the host,
 * decide primary/secondary, and only an instance that owns the version lock builds the
 * domain services. A secondary therefore never opens the user's catalog, logs or
 * settings — it forwards its argv and exits 0.
 */
int main(int argc, char **argv)
{
    QCoreApplication application(argc, argv);
    QCoreApplication::setApplicationName(QStringLiteral("PiDeckBackend"));
    QCoreApplication::setOrganizationName(QStringLiteral("PiDeck-Q"));

    BackendEnvironment environment;
    QString error;
    if (!BackendEnvironment::parse(&environment, &error)) {
        std::fprintf(stderr, "PiDeckBackend: %s\n", qUtf8Printable(error));
        return 2;
    }
    // Opt-in diagnosis only (`PIDECK_STACK_DUMP_MS`): no-op for every normal run.
    stackreport::arm();
    lifetrace::mark("main:start");

    auto host = std::make_unique<HostRpcClient>(environment.hostToken);
    if (!host->connectToHost(environment.hostPort)) {
        std::fprintf(stderr, "PiDeckBackend: unable to connect to the native host\n");
        return 1;
    }

    std::unique_ptr<singleinstance::Guard> instance;
    if (singleinstance::readEnabled(environment.userDataDir)) {
        instance = singleinstance::Guard::claim(environment.version, environment.userDataDir, &error);
        if (!instance) {
            if (!error.isEmpty()) {
                // A real endpoint failure (permissions) is not "another instance is live";
                // starting anyway would let two primaries write the same catalogs.
                std::fprintf(stderr, "PiDeckBackend: single-instance endpoint failed: %s\n",
                             qUtf8Printable(error));
                host->closeGracefully(250);
                return 1;
            }
            appfocus::Payload payload;
            payload.at = QDateTime::currentMSecsSinceEpoch();
            payload.fromPid = QCoreApplication::applicationPid();
            // The program name is not part of a launch target; only the arguments are.
            payload.argv = environment.hostArgv.mid(1);
            const bool delivered = singleinstance::forwardFocusRequest(
                singleinstance::endpointFor(environment.userDataDir, environment.version), payload);
            std::fprintf(stderr, "PiDeckBackend: secondary instance forwarding focus request (delivered=%d)\n",
                         delivered ? 1 : 0);
            requestSecondaryExit(*host);
            host->closeGracefully(250);
            return 0;
        }
    }

    int code = 0;
    BackendApplication backend(environment, std::move(host), std::move(instance));
    if (!backend.start()) {
        std::fprintf(stderr, "PiDeckBackend: unable to connect to the native host\n");
        backend.shutdown();
        lifetrace::mark("main:start-failed");
        return 1;
    }
    // Returning from main() (instead of std::_Exit) lets Qt, the socket and the child
    // registry run their destructors and flush.
    lifetrace::mark("main:exec-enter");
    code = QCoreApplication::exec();
    lifetrace::mark("main:exec-return");

    // The serial domain executor is the only owner of domain state, so it must be quiesced
    // before `backend`'s services go away. Its drain deadline is spent once: if `shutdown()`
    // already gave up on the body in flight, this returns immediately instead of waiting a
    // second budget. A body that truly outlives the budget is a network command still running
    // against application state, so exit immediately without destructors (the host is already
    // force-killing the job object at that point).
    if (!background::drainAndStop(2'000)) {
        lifetrace::mark("main:drain-abandoned");
        std::fflush(stderr);
        std::_Exit(code);
    }
    lifetrace::mark("main:drain-ok");
    return code;
}
