#include "ChannelContext.h"

#include "SessionCatalog.h"

void registerSessionChannels(ChannelRegistry &registry, ChannelServices &services)
{
    // Catalog identity, history paging, importers and the scratch pad all own their own
    // modules; this function only wires the session-adjacent ones together.
    registerSessionCatalogChannels(registry, services);
    registerSessionHistoryChannels(registry, services);
    registerSessionImportChannels(registry, services);

    // `scratch-pad:*` is owned by `registerScratchPadChannels` (domain/ScratchPadChannels.cpp).
    // This file used to register a second copy of the whole domain; because the registry
    // resolves async handlers first and `insert` keeps the newest sync handler, the two
    // copies silently alternated depending on registration order (`scratch-pad:delete`
    // and `scratch-pad:export` came from the domain module, `list`/`create`/`load`/`save`
    // from here). The duplicate is gone so a single module owns the domain.

    // Runtime channels (activation, prompt dispatch, commands, UI responses) live in
    // the runtime domain; this function only registers the session-adjacent modules.
    registerRuntimeChannels(registry, services);
}
