#include "TrashHelper.h"

#include "HostRpcClient.h"

#include <QJsonObject>

#include <memory>

namespace trashhelper {
namespace {

/**
 * Sequential recycle-bin chain for a batch of paths.
 *
 * Deliberately a class rather than a self-capturing `std::function`: a lambda that
 * holds a `shared_ptr` to the `std::function` containing itself is destroyed while
 * it is still executing, which frees the running frame. `shared_from_this` gives the
 * continuations a keep-alive handle without creating that cycle.
 */
class TrashChain : public std::enable_shared_from_this<TrashChain> {
public:
    TrashChain(HostRpcClient *host, QStringList paths, TypedDone done, bool typed,
               scopedmutation::Root scope = {})
        : m_host(host), m_paths(std::move(paths)), m_done(std::move(done)), m_typed(typed), m_scope(std::move(scope))
    {
    }

    void start() { step(); }

private:
    void step()
    {
        if (m_settled) return;
        if (m_index >= m_paths.size()) return finish(Result::Success, QString());
        const QString path = m_paths.at(m_index++);
        QJsonObject params{{QStringLiteral("path"), path}, {QStringLiteral("typedFailure"), m_typed}};
        if (!m_scope.identity.isEmpty()) {
            try {
                const scopedmutation::Parent guard(m_scope, path);
                params.insert(QStringLiteral("scope"), m_scope.toJson());
            } catch (const std::exception &failure) {
                return finish(Result::Error, QString::fromUtf8(failure.what()));
            }
        }
        auto request = m_host->request(QStringLiteral("shell.trashItem"), params);
        // One file at a time keeps the recycle-bin order deterministic and stops the
        // batch on the first failure, so a partial delete is reported honestly.
        std::shared_ptr<TrashChain> self = shared_from_this();
        request->then([self](const QJsonValue &value) {
            if (self->m_typed && value.isObject() &&
                value.toObject().value(QStringLiteral("status")).toString() == QLatin1String("trash-failed")) {
                self->finish(Result::TrashFailed, QString());
                return;
            }
            if (self->m_typed && !value.isNull()) {
                self->finish(Result::Error, QStringLiteral("Invalid native trash response"));
                return;
            }
            self->step();
        });
        request->fail([self](const QString &error) { self->finish(Result::Error, error); });
    }

    void finish(Result result, const QString &error)
    {
        if (m_settled) return;
        m_settled = true;
        if (m_done) m_done(result, error);
    }

    HostRpcClient *m_host;
    QStringList m_paths;
    TypedDone m_done;
    bool m_typed;
    scopedmutation::Root m_scope;
    int m_index = 0;
    bool m_settled = false;
};

} // namespace

void trashAll(HostRpcClient *host, const QStringList &paths, Done done)
{
    if (!host) {
        if (done) done(false, QStringLiteral("Native host bridge is unavailable"));
        return;
    }
    if (paths.isEmpty()) {
        if (done) done(true, QString());
        return;
    }
    std::make_shared<TrashChain>(host, paths,
        [done = std::move(done)](Result result, const QString &error) {
            if (done) done(result == Result::Success, error);
        }, false)->start();
}

void trashAllTyped(HostRpcClient *host, const QStringList &paths, TypedDone done,
                   const scopedmutation::Root &scope)
{
    if (!host) {
        if (done) done(Result::Error, QStringLiteral("Native host bridge is unavailable"));
        return;
    }
    std::make_shared<TrashChain>(host, paths, std::move(done), true, scope)->start();
}

} // namespace trashhelper
