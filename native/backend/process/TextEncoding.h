#pragma once

#include <QByteArray>
#include <QString>

#include <stdexcept>
#include <string>

/**
 * QString → std::string without crossing the Qt ABI with std::string.
 *
 * `QString::toStdString()` returns a `std::string` **by value** out of the Qt6Core
 * library. `std::string` has no stable ABI on MSVC: the debug build uses a different
 * `_ITERATOR_DEBUG_LEVEL` than the release-built Qt DLL, so the returned object's
 * layout does not match the caller's and reading it faults. Converting through
 * `QByteArray` (a Qt type with a stable layout) keeps the boundary safe.
 */
namespace textenc {

inline std::string toUtf8(const QString &value)
{
    const QByteArray bytes = value.toUtf8();
    return std::string(bytes.constData(), size_t(bytes.size()));
}

/** Build a std::runtime_error without letting std::string cross the Qt ABI. */
inline std::runtime_error error(const QString &message)
{
    return std::runtime_error(toUtf8(message));
}

} // namespace textenc
