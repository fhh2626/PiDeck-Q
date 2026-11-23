#include "SessionWslTrashScript.h"

namespace sessiondelete {
const QString &wslTrashScript()
{
    static const QString script = QStringLiteral(R"PIDECK_TRASH(
# pideck-scoped-trash-v1
set -eu
set -f
root=$1
identity=$2
pin=$3
start=$4
shift 4
# Duplicate the holder's original inode, never reopen a replaceable root name.
# Start-time checks fence PID reuse on either side of the descriptor transfer.
pin_state() {
    record=$(cat "/proc/$pin/stat") || exit 1
    record=${record##*) }
    set -- $record
    [ "${20}" = "$start" ]
}
pin_state
exec 3<"/proc/$pin/fd/3"
pin_state
cd -P -- /proc/self/fd/3
[ "$(pwd -P)" = "$root" ]
[ "$(stat -Lc '%d:%i' -- .)" = "$identity" ]
# Each cd binds the actual directory. Checking its physical name after cd rejects
# a redirected component; subsequent operations remain cwd/fd-relative if renamed.
walk() {
    relative=$1
    create=$2
    cd -P -- /proc/self/fd/3
    expected=$root
    previous=$IFS
    IFS=/
    set -- $relative
    IFS=$previous
    for component do
        case "$component" in ''|.|..) exit 1;; esac
        if [ "$create" = yes ]; then
            mkdir -m 700 -- "$component" 2>/dev/null || [ -d "$component" ]
        fi
        cd -P -- "$component"
        expected=${expected%/}/$component
        [ "$(pwd -P)" = "$expected" ]
    done
}
while [ "$#" -gt 0 ]; do
    from=$1
    to=$2
    shift 2
    from_name=${from##*/}
    to_name=${to##*/}
    from_parent=${from%/*}
    to_parent=${to%/*}
    [ "$from_parent" != "$from" ] || from_parent=
    [ "$to_parent" != "$to" ]
    walk "$from_parent" no
    exec 6<.
    walk "$to_parent" yes
    exec 5<.
    cd -P -- /proc/self/fd/6
    if [ -e "./$from_name" ] || [ -L "./$from_name" ]; then
        # Refuse cross-volume copies. A move must be one entry-level rename, not
        # a copy/unlink traversal of an asynchronously changing directory tree.
        [ "$(stat -c '%d' -- "./$from_name")" = "$(stat -Lc '%d' -- /proc/self/fd/5)" ]
        # Device numbers alone do not rule out EXDEV on bind/overlay mounts.
        # Older mv without --no-copy must refuse, never silently copy then unlink.
        mv --no-copy --help >/dev/null 2>&1 || exit 42
        mv --no-copy -n -T -- "./$from_name" "/proc/self/fd/5/$to_name"
        [ ! -e "./$from_name" ] && [ ! -L "./$from_name" ]
    fi
    exec 5<&- 6<&-
done
)PIDECK_TRASH").replace(QStringLiteral("\r\n"), QStringLiteral("\n"));
    return script;
}
} // namespace sessiondelete
