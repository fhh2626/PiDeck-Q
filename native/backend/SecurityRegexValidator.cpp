#include "SecurityRegexValidator.h"

#include "SecurityRegexValidatorSource.h"

namespace security::internal {

SecurityRegexValidator::SecurityRegexValidator()
{
    // QRegularExpression uses PCRE, while Qt's own RegExp lacks lookbehind.
    // Execute only the embedded ECMAScript parser, with no runtime file lookup.
    const QJSValue loaded = engine_.evaluate(QString::fromUtf8(kSecurityRegexValidatorSource),
                                            QStringLiteral("pideck-security-regex-validator.js"));
    if (loaded.isError()) return;
    validatePattern_ = engine_.globalObject().property(QStringLiteral("PiDeckSecurityRegex"))
                           .property(QStringLiteral("validatePattern"));
}

bool SecurityRegexValidator::isValid(const QString &pattern) const
{
    if (!validatePattern_.isCallable()) return false;
    // The supplied pattern is data. Never interpolate it into evaluated source.
    const QJSValue result = validatePattern_.call({QJSValue(pattern)});
    return result.isBool() && result.toBool();
}

} // namespace security::internal
