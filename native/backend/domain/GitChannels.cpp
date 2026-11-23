#include "ChannelContext.h"

#include "GitChannelParts.h"

/**
 * Git domain entry point.
 *
 * The domain is split in two registration functions so neither file grows past the
 * project's module-size guidance: read-only channels (status, diffs, history, refs,
 * worktrees) and mutations (stage/unstage/discard/commit/remote/reset/delete/AI
 * message). This function is wiring only.
 */
void registerGitChannels(ChannelRegistry &registry, ChannelServices &services)
{
    registerGitReadChannels(registry, services);
    registerGitMutationChannels(registry, services);
}
