#include "SessionDeleteChannels.h"

#include "SessionChannelSupport.h"
#include "SessionDelete.h"
#include "SessionWslTrashScript.h"
#include "RuntimeCoordinator.h"
#include "../runtime/DeletionIdentity.h"
#include "../fs/TrashHelper.h"

namespace sessionchannels {
namespace {

/** Release on cancellation/synchronous throws too, without releasing a later retry's pin. */
class CatalogPin {
public:
    CatalogPin(SessionCatalogStore &catalog, QString id) : catalog(catalog), id(std::move(id)) {}
    ~CatalogPin() { release(); }
    void release() { if (!released) { released = true; catalog.releaseDeletion(id); } }
private:
    SessionCatalogStore &catalog;
    QString id;
    bool released = false;
};

/** Plan and perform filesystem work off-thread; host trash requests stay on the owner loop. */
void executeDelete(ChannelServices &services, const CatalogEntry &entry,
                   const SessionScanner::DeletionSnapshot &snapshot, bool permanent,
                   ChannelResponder responder, const deletionidentity::NativeLease &nativeLease = {},
                   const deletionidentity::Lease &wslLease = {})
{
    const QString sessionId = entry.id;
    auto nativeScope = std::make_shared<scopedmutation::Root>();
    background::runBlocking([&services, sessionId, entry, snapshot, permanent, nativeScope, nativeLease, wslLease]() -> QJsonValue {
        CatalogEntry current;
        if (!findEntry(services, sessionId, &current))
            return QJsonObject{{QStringLiteral("missing"), true}};
        // Never mutate a later catalog identity under an earlier runtime reservation.
        if (!deletionidentity::sameTarget(entry, current))
            throw ChannelError(QStringLiteral("Session deletion identity changed"));
        SessionScanner &scanner = scannerOf(services);
        SessionScanner::DeletionStorage deletion{snapshot.fs, {}};
        if (!entry.filePath.isEmpty()) {
            const QString projectPath = requireProjectPath(services, entry.projectId);
            deletion = scanner.deletionStorage(entry.filePath, projectPath,
                                                runtimeProjectPath(services, projectPath), snapshot);
            // Catalog identities survive environment switches. Never reinterpret a
            // stored Linux path in another distribution (or as a native host path).
            const auto &config = deletion.fs.config();
            const bool wslEntry = entry.environment == QLatin1String("wsl");
            if (wslEntry != deletion.fs.wsl()
                || (wslEntry && ((!entry.wslDistro.isEmpty() && entry.wslDistro.compare(config.distro, Qt::CaseInsensitive) != 0)
                    || (!entry.wslUser.isEmpty() && entry.wslUser != config.user)))) {
                throw ChannelError(QStringLiteral("Session deletion environment does not match the catalog"));
            }
        }
        const auto nativePlan = [&] {
            const auto planned = sessiondelete::plan(deletion.fs, entry.filePath, deletion.root);
            // Admission happens before this worker resolves settings/root aliases.
            // A retarget must fail before either permanent or host trash mutations.
            if (!nativeLease.matchesPlan(planned.sessionFile))
                throw ChannelError(QStringLiteral("Session deletion identity changed"));
            return planned;
        };
        QJsonObject plan{{QStringLiteral("projectId"), entry.projectId}};
        if (permanent) {
            if (deletion.fs.wsl())
                throw ChannelError(QStringLiteral("Permanent deletion is unavailable for WSL sessions"));
            if (!entry.filePath.isEmpty())
                sessiondelete::removePermanently(nativePlan());
            catalogOf(services).removePinned(entry);
            plan.insert(QStringLiteral("complete"), true);
        } else if (!entry.filePath.isEmpty() && deletion.fs.wsl()) {
            try { sessiondelete::softDeleteWsl(deletion.fs, entry.filePath, deletion.root, &wslLease); }
            catch (const sessiondelete::WslTrashUnavailable &) {
                throw ChannelError(translateOf(services)(QStringLiteral("session.wslSafeTrashUnavailable"), {}));
            }
        } else if (!entry.filePath.isEmpty()) {
            const sessiondelete::Plan planned = nativePlan();
            *nativeScope = planned.nativeRoot;
            QJsonArray targets;
            for (const QString &path : planned.backups) targets.append(path);
            for (const QString &path : planned.artifacts) targets.append(path);
            if (planned.hasSibling) targets.append(planned.siblingDir);
            if (planned.hasFile) targets.append(planned.sessionFile);
            // Reject the entire plan before moving the first entry (including a
            // pathological companion equal to the authorized root itself).
            for (const auto &target : targets) {
                const scopedmutation::Parent guard(planned.nativeRoot, target.toString());
            }
            plan.insert(QStringLiteral("targets"), targets);
        }
        return plan;
    }, [&services, sessionId, entry, responder, nativeScope](background::Outcome outcome) mutable {
        if (!outcome.ok) return responder.reject(outcome.error);
        const QJsonObject plan = outcome.value.toObject();
        if (plan.value(QStringLiteral("missing")).toBool()) return responder.resolve(false);
        const QString projectId = plan.value(QStringLiteral("projectId")).toString();
        auto finish = [&services, entry, projectId, responder]() mutable {
            try {
                catalogOf(services).removePinned(entry);
                notifyCatalogRefreshed(services, projectId);
                responder.resolve(true);
            } catch (const std::exception &failure) {
                responder.reject(QString::fromUtf8(failure.what()));
            }
        };
        if (plan.value(QStringLiteral("complete")).toBool()) {
            notifyCatalogRefreshed(services, projectId);
            return responder.resolve(true);
        }
        const QJsonArray targets = plan.value(QStringLiteral("targets")).toArray();
        if (targets.isEmpty()) return finish();
        QStringList paths;
        for (const QJsonValue &path : targets) paths.append(path.toString());
        trashhelper::trashAllTyped(services.host, paths,
            [finish, responder](trashhelper::Result result, const QString &error) mutable {
                if (result == trashhelper::Result::TrashFailed) {
                    responder.resolve(QJsonObject{{QStringLiteral("status"), QStringLiteral("trash-failed")}});
                } else if (result == trashhelper::Result::Error) {
                    responder.reject(error);
                } else {
                    finish();
                }
            }, *nativeScope);
    });
}

} // namespace

void registerSessionDeleteChannel(ChannelRegistry &registry, ChannelServices &services)
{
    registry.addAsync(QStringLiteral("sessions:catalog-delete"),
        [&services](const QJsonArray &args, ChannelResponder responder) {
            const QString sessionId = channels::stringArg(args, 0);
            bool permanent = false;
            if (args.size() > 2) throw ChannelError(QStringLiteral("Invalid deletion options"));
            if (args.size() > 1 && !args.at(1).isUndefined()) {
                if (!args.at(1).isObject()) throw ChannelError(QStringLiteral("Invalid deletion options"));
                const QJsonObject options = args.at(1).toObject();
                if (options.size() != 1 || !options.value(QStringLiteral("permanent")).isBool())
                    throw ChannelError(QStringLiteral("Invalid deletion options"));
                permanent = options.value(QStringLiteral("permanent")).toBool();
            }
            CatalogEntry entry;
            if (!findEntry(services, sessionId, &entry)) return responder.resolve(false);
            // Capture before the first asynchronous identity probe. A settings change
            // must not redirect either canonicalization or subsequent filesystem work.
            const auto snapshot = scannerOf(services).deletionSnapshot();
            if (!catalogOf(services).pinDeletion(entry))
                return responder.reject(translateOf(services)(QStringLiteral("session.deletionInProgress"), {}));
            // The catalog pin spans every async path, including isolated wiring.
            // It releases before the client can ask for permanent-delete consent.
            auto pin = std::make_shared<CatalogPin>(catalogOf(services), sessionId);
            ChannelResponder client = responder;
            responder = ChannelResponder(
                [pin, client](const QJsonValue &value) mutable { pin->release(); client.resolve(value); },
                [pin, client](const QString &error) mutable { pin->release(); client.reject(error); });
            if (!services.runtimeCoordinator) {
                // Isolated wiring has no owner to reserve, but still retains the legacy busy guard.
                querySessionTreeIdle(services, sessionId,
                    [&services, entry, snapshot, permanent, responder] { executeDelete(services, entry, snapshot, permanent, responder); },
                    [responder](const QString &error) mutable { responder.reject(error); });
                return;
            }
            auto *owner = services.runtimeCoordinator;
            owner->reserveDeletionAsync(entry, snapshot.fs,
                [&services, owner, sessionId, entry, snapshot, permanent, responder](const QJsonObject &block) mutable {
                    if (!block.isEmpty()) {
                        const QString key = block.value(QStringLiteral("kind")).toString() == QLatin1String("file-in-use")
                            ? QStringLiteral("session.inUseDeleteBlocked")
                            : block.value(QStringLiteral("sessionId")).toString() == sessionId
                                ? QStringLiteral("session.stopBeforeDelete")
                                : QStringLiteral("session.childRunningDeleteBlocked");
                        const QString kind = block.value(QStringLiteral("kind")).toString();
                        const QString error = kind == QLatin1String("deleting")
                            ? translateOf(services)(QStringLiteral("session.deletionInProgress"), {})
                            : kind.startsWith(QLatin1String("identity-"))
                                ? translateOf(services)(QStringLiteral("session.deleteIdentityUnverified"), {})
                                : translateOf(services)(key, QJsonObject{{QStringLiteral("title"), block.value(QStringLiteral("agentTitle"))}});
                        return responder.reject(error);
                    }
                    // Exactly-once settlement releases on every success/error/host-timeout path.
                    // Release before responding so a user retry after the dialog can acquire again.
                    ChannelResponder reserved(
                        [owner, sessionId, responder](const QJsonValue &value) mutable {
                            owner->releaseDeletion(sessionId);
                            responder.resolve(value);
                        },
                        [owner, sessionId, responder](const QString &error) mutable {
                            owner->releaseDeletion(sessionId);
                            responder.reject(error);
                        });
                    try {
                        executeDelete(services, entry, snapshot, permanent, reserved,
                                      owner->nativeDeletionLease(sessionId), owner->wslDeletionLease(sessionId));
                    } catch (const std::exception &failure) {
                        reserved.reject(QString::fromUtf8(failure.what()));
                    }
                });
        });
}

} // namespace sessionchannels
