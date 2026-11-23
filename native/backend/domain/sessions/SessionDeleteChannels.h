#pragma once

class ChannelRegistry;
struct ChannelServices;

namespace sessionchannels {
/** Register deletion with an owner-thread reservation covering the entire asynchronous operation. */
void registerSessionDeleteChannel(ChannelRegistry &registry, ChannelServices &services);
}
