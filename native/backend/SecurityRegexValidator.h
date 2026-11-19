#pragma once

#include <QJSEngine>
#include <QJSValue>
#include <QString>

namespace security::internal {

// One engine per validation batch keeps Qt thread ownership local and avoids
// reloading the parser for each level or pattern.
class SecurityRegexValidator final {
public:
    SecurityRegexValidator();
    bool isValid(const QString &pattern) const;

private:
    QJSEngine engine_;
    QJSValue validatePattern_;
};

} // namespace security::internal
