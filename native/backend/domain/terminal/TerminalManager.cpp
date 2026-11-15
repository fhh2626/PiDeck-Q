#include "TerminalManager.h"

#include "ShellDiscovery.h"

#include "../process/ChildEnvironment.h"
#include "../ChannelRegistry.h"

#include <QDateTime>
#include <QJsonValue>
#include <QProcessEnvironment>
#include <QStringConverter>
#include <QUuid>

#include <vector>

namespace terminal {
namespace {

QJsonObject tabJson(const QString &id, const QString &agentId, const QString &ownerKey, const QString &title,
                    const QString &cwd, const QString &shell, qint64 createdAt, bool exited, bool hasExitCode,
                    int exitCode, const QString &buffer, bool includeBuffer)
{
    QJsonObject tab{
        {QStringLiteral("id"), id},
        {QStringLiteral("agentId"), agentId},
        {QStringLiteral("ownerKey"), ownerKey},
        {QStringLiteral("title"), title},
        {QStringLiteral("cwd"), cwd},
        {QStringLiteral("shell"), shell},
        {QStringLiteral("createdAt"), static_cast<double>(createdAt)},
    };
    if (exited) {
        tab.insert(QStringLiteral("exited"), true);
        if (hasExitCode) tab.insert(QStringLiteral("exitCode"), exitCode);
    }
    if (includeBuffer) tab.insert(QStringLiteral("buffer"), buffer);
    return tab;
}

} // namespace

QJsonObject Manager::Tab::toJson(bool includeBuffer) const
{
    return tabJson(id, agentId, ownerKey, title, cwd, shell, createdAt, exited, hasExitCode, exitCode, buffer,
                   includeBuffer);
}

Manager::Manager(TargetValidator validator, CwdResolver cwdResolver, Emitter emitter, QObject *parent)
    : QObject(parent)
    , m_validator(std::move(validator))
    , m_cwdResolver(std::move(cwdResolver))
    , m_emitter(std::move(emitter))
{
}

Manager::~Manager()
{
    // Stop PTY callbacks before any member is destroyed, then join the threads through
    // closeAll so no worker can post to a half-destroyed object.
    m_alive->store(false);
    closeAll();
}

void Manager::resolveTarget(const QJsonObject &target, Target *parsed, QString *ownerKey, QString *cwd) const
{
    *parsed = targetFromJson(target);
    if (parsed->kind == Target::Kind::Agent) {
        // The coordinator owns the binding table: a stale session/agent/generation must
        // be rejected here so a terminal can never attach to a replaced process.
        QString error;
        if (!m_validator || !m_validator(target, &error)) {
            throw ChannelError(error.isEmpty() ? QStringLiteral("Session runtime is not available") : error);
        }
        *cwd = m_cwdResolver ? m_cwdResolver(parsed->agentId) : QString();
    } else {
        // A project target carries its own cwd; it is only a working directory, never
        // an executable, so it is passed through unchanged like the oracle does.
        *cwd = parsed->cwd;
        if (cwd->isEmpty()) throw ChannelError(QStringLiteral("Terminal cwd is required"));
    }
    *ownerKey = ownerKeyFor(*parsed, *cwd);
}

QHash<QString, std::shared_ptr<Manager::Tab>> &Manager::ensureOwner(const QString &ownerKey)
{
    return m_owners[ownerKey].tabs;
}

std::shared_ptr<Manager::Tab> Manager::findTab(const QString &tabId, QString *ownerKey) const
{
    for (auto owner = m_owners.constBegin(); owner != m_owners.constEnd(); ++owner) {
        const auto tab = owner->tabs.constFind(tabId);
        if (tab == owner->tabs.constEnd()) continue;
        if (ownerKey) *ownerKey = owner.key();
        return tab.value();
    }
    return nullptr;
}

std::shared_ptr<Manager::Tab> Manager::requireTab(const QString &tabId)
{
    std::shared_ptr<Tab> tab = findTab(tabId, nullptr);
    if (!tab) throw ChannelError(QStringLiteral("Terminal not found: %1").arg(tabId));
    return tab;
}

QJsonArray Manager::list(const QJsonObject &target)
{
    Target parsed;
    QString ownerKey;
    QString cwd;
    resolveTarget(target, &parsed, &ownerKey, &cwd);
    QJsonArray tabs;
    const auto owner = m_owners.constFind(ownerKey);
    if (owner == m_owners.constEnd()) return tabs;
    for (const std::shared_ptr<Tab> &tab : owner->tabs) tabs.append(tab->toJson(true));
    return tabs;
}

QJsonArray Manager::ensure(const QJsonObject &target)
{
    const QJsonArray existing = list(target);
    if (!existing.isEmpty()) return existing;
    // StrictMode mounts the dock twice; creating only when nothing exists keeps the
    // list-then-create race from producing two terminals.
    return QJsonArray{create(target)};
}

QJsonObject Manager::create(const QJsonObject &target, const QString &preferredShell)
{
    Target parsed;
    QString ownerKey;
    QString cwd;
    resolveTarget(target, &parsed, &ownerKey, &cwd);
    QHash<QString, std::shared_ptr<Tab>> &tabs = ensureOwner(ownerKey);
    const int index = tabs.size() + 1;
    const QString tabId = QUuid::createUuid().toString(QUuid::WithoutBraces);

    // PTY callbacks run on worker threads; every mutation is re-posted to the thread
    // that owns this manager so the tab table and the replay buffer stay single-owner.
    PtyProcess::Callbacks callbacks;
    callbacks.onData = [this, tabId, alive = m_alive](const QByteArray &bytes) {
        if (!alive->load()) return;
        QMetaObject::invokeMethod(
            this, [this, tabId, bytes] { handleData(tabId, bytes); }, Qt::QueuedConnection);
    };
    callbacks.onExit = [this, tabId, alive = m_alive](int exitCode) {
        if (!alive->load()) return;
        QMetaObject::invokeMethod(
            this, [this, tabId, exitCode] { handleExit(tabId, exitCode); }, Qt::QueuedConnection);
    };

    QString shellId;
    QString error;
    std::unique_ptr<PtyProcess> process = spawnShell(cwd, preferredShell, callbacks, &shellId, &error);
    if (!process) throw ChannelError(error);

    auto tab = std::make_shared<Tab>();
    tab->id = tabId;
    tab->agentId = parsed.kind == Target::Kind::Agent ? parsed.agentId : QString();
    tab->ownerKey = ownerKey;
    tab->title = QStringLiteral("%1 %2").arg(displayShell(shellId)).arg(index);
    tab->cwd = cwd;
    tab->shell = shellId;
    tab->createdAt = QDateTime::currentMSecsSinceEpoch();
    tab->decoder = std::make_unique<QStringDecoder>(QStringDecoder::Utf8);
    tab->process = std::move(process);
    tabs.insert(tabId, tab);
    return tab->toJson(false);
}

std::unique_ptr<PtyProcess> Manager::spawnShell(const QString &cwd, const QString &preferredShell,
                                                const PtyProcess::Callbacks &callbacks, QString *shellId,
                                                QString *error)
{
    const std::vector<ShellCandidate> candidates = shellCandidates();
    std::vector<ShellCandidate> ordered;
    ordered.reserve(candidates.size());
    if (!preferredShell.isEmpty()) {
        for (const ShellCandidate &candidate : candidates) {
            if (candidate.shell == preferredShell) ordered.push_back(candidate);
        }
    }
    for (const ShellCandidate &candidate : candidates) {
        if (!preferredShell.isEmpty() && candidate.shell == preferredShell) continue;
        ordered.push_back(candidate);
    }

    QString lastError;
    for (const ShellCandidate &candidate : ordered) {
        QProcessEnvironment environment = childenv::sanitized();
        // A GUI-launched backend does not inherit the login shell environment, so the
        // locale is pinned or UTF-8 output inside the terminal renders as mojibake.
        if (environment.value(QStringLiteral("LANG")).isEmpty()) {
            environment.insert(QStringLiteral("LANG"), QStringLiteral("en_US.UTF-8"));
        }
        if (environment.value(QStringLiteral("LC_ALL")).isEmpty()) {
            environment.insert(QStringLiteral("LC_ALL"), QStringLiteral("en_US.UTF-8"));
        }
        QString spawnError;
        std::unique_ptr<PtyProcess> process =
            PtyProcess::spawn(candidate.command, candidate.args, cwd, PtySize{}, environment, callbacks, &spawnError);
        if (process) {
            *shellId = candidate.shell;
            return process;
        }
        lastError = spawnError;
    }
    *error = lastError.isEmpty() ? QStringLiteral("No supported shell found") : lastError;
    return nullptr;
}

void Manager::input(const QString &tabId, const QString &data)
{
    std::shared_ptr<Tab> tab = requireTab(tabId);
    if (tab->exited) return;
    QString error;
    if (tab->process && !tab->process->write(data.toUtf8(), &error)) throw ChannelError(error);
}

void Manager::resize(const QString &tabId, int cols, int rows)
{
    std::shared_ptr<Tab> tab = findTab(tabId, nullptr);
    if (!tab || tab->exited) return;
    // A collapsed dock reports a 0-sized viewport; clamp so the PTY stays usable.
    if (tab->process) tab->process->resize(qMax(2, cols), qMax(1, rows));
}

void Manager::close(const QString &tabId)
{
    QString ownerKey;
    std::shared_ptr<Tab> tab = findTab(tabId, &ownerKey);
    if (!tab) return;
    if (tab->process) tab->process->kill();
    const auto owner = m_owners.find(ownerKey);
    if (owner != m_owners.end()) {
        owner->tabs.remove(tabId);
        if (owner->tabs.isEmpty()) m_owners.erase(owner);
    }
}

void Manager::closeAgent(const QString &agentId)
{
    closeOwner(QStringLiteral("agent:") + agentId);
}

void Manager::closeOwner(const QString &ownerKey)
{
    const auto owner = m_owners.find(ownerKey);
    if (owner == m_owners.end()) return;
    // Take the tabs out first: a killed process posts its exit callback, and the
    // handler must not resurrect a tab that is already gone.
    const QHash<QString, std::shared_ptr<Tab>> tabs = owner->tabs;
    m_owners.erase(owner);
    for (const std::shared_ptr<Tab> &tab : tabs) {
        if (tab->process) tab->process->kill();
    }
}

void Manager::closeAll()
{
    const QStringList owners = m_owners.keys();
    for (const QString &ownerKey : owners) closeOwner(ownerKey);
}

QJsonArray Manager::shells() const
{
    QJsonArray result;
    for (const ShellCandidate &candidate : shellCandidates()) {
        result.append(QJsonObject{
            {QStringLiteral("shell"), candidate.shell},
            {QStringLiteral("label"), displayShell(candidate.shell)},
            {QStringLiteral("available"), true},
        });
    }
    return result;
}

int Manager::tabCount() const
{
    int total = 0;
    for (auto owner = m_owners.constBegin(); owner != m_owners.constEnd(); ++owner) total += owner->tabs.size();
    return total;
}

void Manager::appendBuffer(Tab &tab, const QString &data)
{
    // The renderer unmounts the dock when switching project/agent, so the backend keeps
    // a bounded replay to rebuild xterm scrollback without unbounded memory growth.
    tab.buffer += data;
    if (tab.buffer.size() > kMaxReplayBuffer) tab.buffer = tab.buffer.right(kMaxReplayBuffer);
}

void Manager::handleData(const QString &tabId, const QByteArray &bytes)
{
    std::shared_ptr<Tab> tab = findTab(tabId, nullptr);
    if (!tab) return;
    // Decode incrementally: a UTF-8 sequence split across two reads must not turn into
    // replacement characters in the middle of the terminal stream.
    const QString text = tab->decoder->decode(bytes);
    if (text.isEmpty()) return;
    appendBuffer(*tab, text);
    m_emitter(QStringLiteral("terminal:data"),
              QJsonArray{QJsonObject{{QStringLiteral("tabId"), tabId}, {QStringLiteral("data"), text}}});
}

void Manager::handleExit(const QString &tabId, int exitCode)
{
    std::shared_ptr<Tab> tab = findTab(tabId, nullptr);
    if (!tab || tab->exited) return;
    tab->exited = true;
    tab->hasExitCode = true;
    tab->exitCode = exitCode;
    appendBuffer(*tab, QStringLiteral("\r\n[process exited with code %1]\r\n").arg(exitCode));
    m_emitter(QStringLiteral("terminal:exit"),
              QJsonArray{QJsonObject{{QStringLiteral("tabId"), tabId}, {QStringLiteral("exitCode"), exitCode}}});
}

} // namespace terminal
