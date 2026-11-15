#include "ChannelContext.h"

/**
 * Store-domain channel assembly.
 *
 * The store surface is four independent owners, so this file only wires them:
 *  - `PromptChannels.cpp`   — global/project prompt templates;
 *  - `SkillChannels.cpp`    — global skill discovery and mutation;
 *  - `ExtensionChannels.cpp`— pi extension install/remove/update;
 *  - `MarketChannels.cpp`   — the remote catalogues (prompts.chat, xueprompt, skills.sh).
 *
 * Keeping the registration here (instead of in `BackendApplication`) means the domain
 * can be registered as a unit without growing the assembly layer.
 */
void registerPromptChannels(ChannelRegistry &registry, ChannelServices &services);
void registerSkillChannels(ChannelRegistry &registry, ChannelServices &services);
void registerExtensionChannels(ChannelRegistry &registry, ChannelServices &services);
void registerMarketChannels(ChannelRegistry &registry, ChannelServices &services);

void registerStoreChannels(ChannelRegistry &registry, ChannelServices &services)
{
    registerPromptChannels(registry, services);
    registerSkillChannels(registry, services);
    registerExtensionChannels(registry, services);
    registerMarketChannels(registry, services);
}
