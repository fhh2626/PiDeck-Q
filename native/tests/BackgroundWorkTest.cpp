#include "BackgroundWork.h"

#include <QCoreApplication>
#include <QElapsedTimer>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QSemaphore>
#include <QThread>
#include <QTimer>

#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <memory>
#include <thread>

namespace {

struct State {
    QSemaphore domainStarted;
    QSemaphore readStarted;
    QSemaphore domainRelease;
    QSemaphore readRelease;
    QSemaphore mutationsFinished;
    QJsonArray mutationOrder;
    std::atomic<bool> released{false};
    std::atomic<int> queuedBodies{0};
    std::atomic<int> completions{0};
    bool readBeforeRelease = false;
    bool ownerContinuation = false;
};

/** Hold the domain worker while a read completes, then observe mutation FIFO order. */
QJsonObject isolation(QCoreApplication &app)
{
    const auto state = std::make_shared<State>();
    background::runBlocking([state]() -> QJsonValue {
        state->domainStarted.release();
        state->domainRelease.acquire();
        state->mutationOrder.append(1);
        return 1;
    }, [](background::Outcome) {});
    const bool started = state->domainStarted.tryAcquire(1, 5'000);
    background::runBlocking([state]() -> QJsonValue {
        state->mutationOrder.append(2);
        return 2;
    }, [](background::Outcome) {});
    background::runBlocking([state]() -> QJsonValue {
        state->mutationOrder.append(3);
        state->mutationsFinished.release();
        return 3;
    }, [](background::Outcome) {});
    QElapsedTimer elapsed;
    elapsed.start();
    background::runInteractiveRead([]() -> QJsonValue { return QStringLiteral("document"); },
        [state, &app](background::Outcome outcome) {
            state->readBeforeRelease = outcome.ok && outcome.value == QJsonValue(QStringLiteral("document"))
                && !state->released.load();
            state->ownerContinuation = QThread::currentThread() == app.thread();
            app.quit();
        });
    QTimer::singleShot(2'000, &app, &QCoreApplication::quit);
    app.exec();
    const qint64 readElapsed = elapsed.elapsed();
    state->released.store(true);
    state->domainRelease.release();
    const bool mutationsFinished = state->mutationsFinished.tryAcquire(1, 5'000);
    const bool drained = background::drainAndStop(5'000);
    return {{QStringLiteral("domainStarted"), started}, {QStringLiteral("readBeforeRelease"), state->readBeforeRelease},
        {QStringLiteral("ownerContinuation"), state->ownerContinuation}, {QStringLiteral("readElapsedMs"), readElapsed},
        {QStringLiteral("mutationsFinished"), mutationsFinished}, {QStringLiteral("mutationOrder"), state->mutationOrder},
        {QStringLiteral("drained"), drained}};
}

/** Stop both queues before waiting for either worker, using one shared drain budget. */
QJsonObject shutdown(bool timeout)
{
    const auto state = std::make_shared<State>();
    const auto completed = [state](background::Outcome) { state->completions.fetch_add(1); };
    background::runBlocking([state]() -> QJsonValue {
        state->domainStarted.release();
        state->domainRelease.acquire();
        return 1;
    }, completed);
    background::runInteractiveRead([state]() -> QJsonValue {
        state->readStarted.release();
        state->readRelease.acquire();
        return 2;
    }, completed);
    const bool domainStarted = state->domainStarted.tryAcquire(1, 5'000);
    const bool readStarted = state->readStarted.tryAcquire(1, 5'000);
    const auto queued = [state]() -> QJsonValue { state->queuedBodies.fetch_add(1); return 0; };
    background::runBlocking(queued, completed);
    background::runInteractiveRead(queued, completed);
    std::thread release([state, timeout] {
        // The read finishes before the domain task. A drain that stops the read
        // queue only after joining the domain worker would execute its queued body.
        std::this_thread::sleep_for(std::chrono::milliseconds(timeout ? 1'000 : 25));
        state->readRelease.release();
        if (!timeout) std::this_thread::sleep_for(std::chrono::milliseconds(225));
        state->domainRelease.release();
    });
    QElapsedTimer timer;
    timer.start();
    const bool drained = background::drainAndStop(timeout ? 200 : 2'000);
    const qint64 elapsed = timer.elapsed();
    timer.restart();
    const bool secondDrain = background::drainAndStop(2'000);
    const qint64 secondElapsed = timer.elapsed();
    release.join();
    QCoreApplication::processEvents();
    return {{QStringLiteral("domainStarted"), domainStarted}, {QStringLiteral("readStarted"), readStarted},
        {QStringLiteral("drained"), drained}, {QStringLiteral("abandoned"), background::abandoned()},
        {QStringLiteral("elapsedMs"), elapsed}, {QStringLiteral("secondDrain"), secondDrain},
        {QStringLiteral("secondElapsedMs"), secondElapsed},
        {QStringLiteral("queuedBodies"), state->queuedBodies.load()}, {QStringLiteral("completions"), state->completions.load()}};
}

} // namespace

int main(int argc, char **argv)
{
    QCoreApplication app(argc, argv);
    const QString mode = app.arguments().value(1, QStringLiteral("isolation"));
    const QJsonObject result = mode == QLatin1String("isolation") ? isolation(app) : shutdown(mode == QLatin1String("timeout"));
    const QByteArray output = QJsonDocument(result).toJson(QJsonDocument::Compact);
    std::fwrite(output.constData(), 1, size_t(output.size()), stdout);
    std::fputc('\n', stdout);
    std::fflush(stdout);
    // The production shutdown contract forbids destructors after an abandoned drain.
    if (background::abandoned()) std::_Exit(0);
    return 0;
}
