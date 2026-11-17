#pragma once
#include <QString>
#include <stdexcept>

namespace sessiondelete {
/** A capability failure, never permission to retry with permanent deletion. */
class WslTrashUnavailable : public std::runtime_error {
public:
    WslTrashUnavailable() : std::runtime_error("wsl-safe-trash-unavailable") {}
};
/** Linux cwd/dirfd-bound moves. All roots and relative paths are positional arguments. */
const QString &wslTrashScript();
}
