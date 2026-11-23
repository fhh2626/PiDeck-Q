#pragma once

#include <QJsonObject>
#include <QString>
#include <memory>

namespace scopedmutation {
/** Physical directory identity captured before asynchronous native deletion. */
struct Root {
    QString path;
    QString identity;
    // The planner keeps the original inode/file ID allocated across async host work.
    std::shared_ptr<void> lifetime;
    QJsonObject toJson() const;
    static Root fromJson(const QJsonObject &value);
};
Root captureRoot(const QString &directory);
QString mapTarget(const Root &root, const QString &originalDirectory, const QString &target);

/** Windows holds every ancestor against rename/reparse; POSIX retains a no-follow dirfd. */
class Parent {
public:
    Parent(const Root &root, const QString &target);
    ~Parent();
    Parent(const Parent &) = delete;
    Parent &operator=(const Parent &) = delete;
    QString path() const;
    QString leaf() const;
    int descriptor() const;
private:
    struct State;
    std::unique_ptr<State> state;
};

/** Authorization failures throw; an OS trash refusal alone returns false. */
bool moveToTrash(const Root &root, const QString &target);
bool moveToTrash(const Parent &parent);
#ifndef Q_OS_WIN
void removeTree(const Root &root, const QString &target);
void removeTree(const Parent &parent);
#endif

#ifdef Q_OS_WIN
/** Lock a real directory during recursion; release before removing its entry. */
std::shared_ptr<void> lockDirectory(const QString &path);
#endif
} // namespace scopedmutation
