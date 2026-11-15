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
    TrashChain(HostRpcClient *host, QStringList paths, Done done)
        : m_host(host), m_paths(std::move(paths)), m_done(std::move(done))
    {
    }

    void start() { step(); }

private:
    void step()
    {
        if (m_settled) return;
        if (m_index >= m_paths.size()) return finish(true, QString());
        const QString path = m_paths.at(m_index++);
        auto request = m_host->request(QStringLiteral("shell.trashItem"), QJsonObject{
            {QStringLiteral("path"), path},
        });
        // One file at a time keeps the recycle-bin order deterministic and stops the
        // batch on the first failure, so a partial delete is reported honestly.
        std::shared_ptr<TrashChain> self = shared_from_this();
        request->then([self](const QJsonValue &) { self->step(); });
        request->fail([self](const QString &error) { self->finish(false, error); });
    }

    void finish(bool ok, const QString &error)
    {
        if (m_settled) return;
        m_settled = true;
        if (m_done) m_done(ok, error);
    }

    HostRpcClient *m_host;
    QStringList m_paths;
    Done m_done;
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
    std::make_shared<TrashChain>(host, paths, std::move(done))->start();
}

} // namespace trashhelper
