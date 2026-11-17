#pragma once

#include "../sessions/SessionFs.h"
#include "../sessions/CatalogTypes.h"
#include "PiLaunch.h"

#include <QHash>
#include <QStringList>

/** Value-only WSL identity resolution. All subprocess work belongs on the domain worker. */
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
/** Resolve a bounded batch; an empty identity is unproven, never evidence of non-overlap. */
QHash<QString, QString> resolve(const SessionFs &fs, const QStringList &paths);

struct Lease {
    CatalogEntry root;
    bool provisional = true;
    QHash<QString, QString> identities;
    /** Unknown paths stay fenced only for this lease's lifetime. */
    bool blocks(const CatalogEntry &candidate) const;
};

} // namespace deletionidentity
