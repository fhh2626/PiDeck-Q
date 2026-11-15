#include "WebLegacyPage.h"

#include "WebClientCopy.h"
#include "WebLegacyDocument.h"

namespace weblegacy {

QByteArray page()
{
    // Exactly the oracle's template with its one interpolation filled in:
    //   renderPage() = documentPrefix + dictionaries + documentSuffix
    // The two halves are static, so the dictionary is the only per-request work.
    QByteArray document = documentPrefix();
    document += webclientcopy::serializedDictionaries();
    document += documentSuffix();
    return document;
}

} // namespace weblegacy
