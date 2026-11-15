#pragma once

#include "ChannelContext.h"

/** Read-only git channels (status, diffs, history, refs, worktrees). */
void registerGitReadChannels(ChannelRegistry &registry, ChannelServices &services);
/** Mutating git channels (stage/unstage/discard/commit/remote/reset/delete/AI message). */
void registerGitMutationChannels(ChannelRegistry &registry, ChannelServices &services);
