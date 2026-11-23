#pragma once

#include <QHash>
#include <QMutex>
#include <QString>
#include <QStringList>

#include <functional>

/**
 * Capability registry for paths obtained from a trusted OS event.
 *
 * Port of src/main/fs/ExternalFileCapabilityStore.ts. Renderer input can never
 * *issue* a capability; it can only redeem one that the native host attached to a
 * clipboard snapshot, an OS file drop or a native open dialog. That is what keeps
 * `files:read-base64-external` / `files:copy-external` from becoming arbitrary
 * filesystem primitives reachable from the WebView.
 *
 * Clipboard entries stay valid for their sequence (the OS clipboard is reusable);
 * drop and picker entries are short-lived and single-use per path.
 *
 * Thread safety: this store is the one piece of domain state touched from both the main
 * thread (clipboard/drop events and the native picker dialog issue capabilities) and the
 * serial domain executor (the redeem channels). A mutex is therefore required here even
 * though every other domain structure is single-owner.
 */
class ExternalFileCapabilities {
public:
    using Clock = std::function<qint64()>;

    explicit ExternalFileCapabilities(Clock clock = nullptr);

    /** Issue or reuse the capability bound to one clipboard sequence. */
    QString issueClipboard(const QStringList &paths, int sequence);
    /** Issue a short-lived capability for one trusted native OS drop. */
    QString issueDrop(const QStringList &paths);
    /** Issue a short-lived capability for paths chosen through a native dialog. */
    QString issuePicker(const QStringList &paths);

    /** Redeem every path of a copy capability (drop/picker are consumed). */
    QStringList consumeCopy(const QString &capabilityId);
    /** Redeem one exact trusted path; the renderer value is only a selector. */
    QString consumeRead(const QString &capabilityId, const QString &requestedPath);

    void revoke(const QString &capabilityId);
    void clear();

    static constexpr qint64 kDropTtlMs = 30'000;
    static constexpr qint64 kPickerTtlMs = 120'000;
    static constexpr int kMaxCapabilities = 256;
    static constexpr int kMaxPathsPerCapability = 128;

private:
    enum class Kind { Clipboard, Drop, Picker };

    struct Entry {
        QStringList paths;
        int sequence = 0;
        bool hasSequence = false;
        qint64 expiresAt = 0;
        bool hasExpiry = false;
        Kind kind = Kind::Clipboard;
    };

    QString createCapability(const QStringList &paths, Kind kind, bool hasSequence, int sequence, bool hasExpiry,
                             qint64 ttlMs);
    void deleteCapability(const QString &capabilityId);
    /** Callers must hold m_mutex: these helpers mutate the maps directly. */
    Entry *entryFor(const QString &capabilityId);
    void pruneExpired();

    mutable QMutex m_mutex;
    QHash<QString, Entry> m_capabilities;
    // Insertion order is the eviction order once the cap is reached.
    QStringList m_order;
    QString m_clipboardCapabilityId;
    Clock m_clock;
};
