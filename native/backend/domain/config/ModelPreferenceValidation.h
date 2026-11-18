#pragma once

#include "ConfigFiles.h"

struct ChannelServices;
struct SettingsCatalogRead;

namespace modelconfig {

/** Only a confirmed deletion in the currently published configuration source invalidates a choice. */
bool isRemoved(const ChannelServices &services, const QString &provider, const QString &modelId);

/** Preserve custom and partial defaults while rejecting late writes of explicitly deleted identities. */
configfiles::Validation validateSettingsSelection(const ChannelServices &services, const QJsonValue &settings,
                                                  const QJsonValue &restoredModels = {});
configfiles::Validation validateRawSettingsSelection(const ChannelServices &services, const QString &fileName,
                                                     const QString &rawJson);
/** A package may restore a removed definition before it writes that same model as a default. */
configfiles::Validation validateImportedSettingsSelection(const ChannelServices &services, const QString &packageJson);

/** Save unrelated desktop settings while clearing stale Git defaults and favorites from this model source. */
SettingsCatalogRead updateDesktopSettings(const ChannelServices &services, const QString &filePath, QJsonObject patch);

} // namespace modelconfig
