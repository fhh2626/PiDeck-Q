#pragma once

#include "ModelThinkingSupport.h"

#include <QJsonArray>
#include <QString>

struct ChannelServices;

/**
 * `pi --list-models` cache (port of `src/main/pi/modelListCache.ts`).
 *
 * Refresh policy, exactly like the oracle:
 *  - the first successful non-empty list is cached for the process lifetime;
 *  - an empty list is never cached (pi may not be ready during startup, and caching an
 *    empty array would permanently render "no matching models");
 *  - an empty result is retried once after 500 ms before giving up;
 *  - `refresh()` bypasses the cache, `invalidate()` drops it.
 *
 * Data source order: the implementation-neutral RPC (`get_available_models`, with the
 * same `--mode rpc --no-session --no-*` argv a runtime uses) and only then the text
 * table. `--offline` is passed as `PI_OFFLINE=1` instead of an argument because `auto`
 * mode may resolve to the Rust build, which does not know the flag.
 *
 * Threading: every entry point runs on the serial domain executor, which replaces the
 * oracle's in-flight promise dedupe (two invokes cannot overlap), so the module-level
 * cache needs no lock. Callers must never call these from the HTTP/SSE main thread: a
 * cold probe can fork pi for up to 20 s.
 */
namespace modellist {

using Models = QJsonArray;

/** Cache-first read; probes pi when the cache is empty. Throws when both sources fail. */
Models fetch(const ChannelServices &services);

/** Force a re-probe and replace the cache. Throws when both sources fail. */
Models refresh(const ChannelServices &services);

/** Drop the cached list without probing (`invalidateModelListCache`). */
void invalidate();

/**
 * `projects:list-models`: fetch + `thinkingLevels` decoration.
 *
 * Never throws: a broken pi or an unreadable models.json yields `[]` / all-false
 * thinking levels, because the composer must stay usable (the oracle returns []).
 *
 * `configDir` is supplied by the caller instead of read from the services: this body runs
 * on the serial domain executor, while the pi config directory is owner-thread state that
 * the WSL switch rewrites, so passing the value captured on the owner thread is what keeps
 * the read coherent.
 */
Models listModels(const ChannelServices &services, const QString &configDir);

/**
 * `resolveModelThinkingSupport`: support bits for one `provider/model` pair.
 *
 * Returns false when `models.json` is unreadable or corrupt — the caller must then skip
 * the clamp instead of treating "unknown" as "unsupported" and downgrading a user
 * preference. A readable file that does not declare the model returns all-false support
 * (the model genuinely offers no extended level).
 */
bool resolveSupport(const ChannelServices &services, const QString &provider,
                    const QString &modelId, ThinkingSupport *support);

} // namespace modellist
