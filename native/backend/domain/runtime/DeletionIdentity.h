#pragma once

#include "../sessions/SessionFs.h"
#include "../sessions/CatalogTypes.h"
#include "PiLaunch.h"

#include <QHash>
#include <QStringList>

/** Value-only deletion identities. All WSL subprocess work belongs on the domain worker. */
namespace deletionidentity {

/** Users share a distribution's filesystem; an unknown distro cannot prove isolation. */
bool sameNamespace(const CatalogEntry &left, const CatalogEntry &right);
/** Capture the actual process namespace instead of inheriting stale catalog metadata. */
CatalogEntry forLaunch(const CatalogEntry &entry, const pilaunch::Launch &launch);
/** A persisted session cannot be reinterpreted in a different runtime filesystem. */
bool compatibleLaunch(const CatalogEntry &entry, const CatalogEntry &launched);
/** Compare precisely the identity protected by a reservation, ignoring mutable display fields. */
bool sameTarget(const CatalogEntry &left, const CatalogEntry &right);
/** Include companion directories independently, because a JSONL leaf may itself be a link. */
QStringList pathsFor(const QString &file);
/** Preserve raw traversal prefixes so aliases cannot hide an entry inside the deleted tree. */
QStringList wslPathsFor(const QString &file);
/** Resolve a bounded batch; an empty identity is unproven, never evidence of non-overlap. */
QHash<QString, QString> resolve(const SessionFs &fs, const QStringList &paths);

/** Freeze native aliases at admission so a later retarget cannot move the runtime fence. */
struct NativeLease {
    CatalogEntry root;
    QStringList physicalPaths;
    /** Resolve the parent at admission while retaining each leaf entry being removed. */
    QStringList entryPaths;
    bool blocks(const CatalogEntry &candidate) const;
    /** An isolated caller has no lease; otherwise planning must retain admitted physical paths. */
    bool matchesPlan(const QString &sessionFile) const;
};

NativeLease captureNative(const CatalogEntry &root);

struct Lease {
    CatalogEntry root;
    bool provisional = true;
    QHash<QString, QString> identities;
    /** Unknown paths stay fenced only for this lease's lifetime. */
    bool blocks(const CatalogEntry &candidate) const;
    /** Check entry/referent identity before mutation; filesystem work stays on the worker. */
    bool matchesPlan(const SessionFs &fs, const QString &sessionFile) const;
};

} // namespace deletionidentity
