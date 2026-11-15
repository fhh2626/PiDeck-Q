#pragma once

#include <QHash>
#include <QJsonArray>
#include <QJsonValue>
#include <QString>

/**
 * Extended thinking-level support (port of `src/shared/thinkingLevelSupport.ts`).
 *
 * The only data source is the local `models.json` `thinkingLevelMap`: a model that
 * explicitly maps `xhigh` or `max` gets those levels in the picker, everything else is
 * reported as unsupported. This is a display contract read by the composer, so the
 * decorator always attaches `thinkingLevels` (never omits it) — a model without support
 * carries `{xhigh:false,max:false}` instead of an absent key.
 */
namespace modellist {

struct ThinkingSupport {
    bool xhigh = false;
    bool max = false;
};

using ThinkingSupportMap = QHash<QString, ThinkingSupport>;

/** `provider\0model` lower-cased; matches the model-list dedupe key. */
QString thinkingSupportKey(const QString &provider, const QString &modelId);

/** True for the two levels `models.json` can declare (`xhigh` / `max`). */
bool isExtendedThinkingLevel(const QString &level);

/**
 * Model-change / preference clamp (`clampThinkingLevelForModel`).
 *
 * An extended level the model does not declare falls back to `high`; every base level
 * and every still-declared extended level is returned unchanged. The caller decides
 * whether the support bit is trustworthy at all: an unreadable `models.json` must skip
 * the clamp instead of downgrading a user preference on a transient I/O error.
 */
QString clampThinkingLevel(const QString &level, const ThinkingSupport &support);

/**
 * `providers[*].models[*].thinkingLevelMap` → support map.
 *
 * `reasoning:false` models are pinned to "no extended levels" even when a stale map is
 * still present, because pi itself only offers `off` for them.
 */
ThinkingSupportMap collectThinkingSupport(const QJsonValue &parsed);

/** Attach `thinkingLevels` to every model; the input array is not modified. */
QJsonArray applyThinkingSupport(const QJsonArray &models, const ThinkingSupportMap &support);

} // namespace modellist
