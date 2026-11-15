#include "BackgroundWork.h"

#include <QCoreApplication>
#include <QMetaObject>
#include <QMutex>
#include <QMutexLocker>
#include <QThread>
#include <QWaitCondition>

#include <atomic>
#include <deque>
#include <exception>
#include <memory>
#include <utility>
#include <vector>

namespace background {
namespace {

/**
 * Single-owner dispatch: one thread, one FIFO queue, no concurrency.
 *
 * The object is intentionally leaked (heap singleton, never destroyed). A static
 * destructor would run after QCoreApplication is gone and could destroy the mutex while
 * the worker thread still holds it; main() stops the executor explicitly through
 * drainAndStop() instead.
 */
class SerialExecutor {
public:
    static SerialExecutor &instance()
    {
        static SerialExecutor *executor = new SerialExecutor();
        return *executor;
    }

    void submit(std::function<void()> job)
    {
        QMutexLocker lock(&m_mutex);
        if (m_stopping || m_abandoned.load(std::memory_order_acquire)) return;
        m_queue.push_back(std::move(job));
        m_wake.wakeOne();
    }

    bool drainAndStop(int timeoutMs)
    {
        {
            QMutexLocker lock(&m_mutex);
            // Settled already: never wait a second time. After a timeout the body is still
            // running and the caller is on its way to `_Exit`, so spending another budget
            // here would only delay the exit it promised.
            if (m_joined) return !m_abandoned.load(std::memory_order_acquire);
            if (m_abandoned.load(std::memory_order_acquire)) return false;
            m_stopping = true;
            m_wake.wakeOne();
        }
        if (m_thread && m_thread->isRunning()) {
            if (!m_thread->wait(static_cast<unsigned long>(qMax(1, timeoutMs)))) {
                // The body in flight is still running against application state. Mark the
                // executor abandoned so nothing is posted into a torn-down QCoreApplication,
                // and let the caller exit without destructors.
                m_abandoned.store(true, std::memory_order_release);
                return false;
            }
        }
        QMutexLocker lock(&m_mutex);
        m_joined = true;
        return true;
    }

    bool abandoned() const { return m_abandoned.load(std::memory_order_acquire); }

    /** True once drainAndStop began: no continuation may reach the event loop any more. */
    bool stopping() const
    {
        QMutexLocker lock(&m_mutex);
        return m_stopping;
    }

    /**
     * Keep a job whose continuation must never run again.
     *
     * Only reached after the drain budget was already spent. Destroying the payload here
     * would touch services the shutdown has begun tearing down (and, on Windows, free memory
     * the release CRT of Qt owns with our debug CRT). The process is inside its exit path at
     * this point, so the bounded leak is intentional: the OS reclaims it.
     */
    void quarantine(std::shared_ptr<void> job)
    {
        static std::vector<std::shared_ptr<void>> *held = new std::vector<std::shared_ptr<void>>();
        QMutexLocker lock(&m_mutex);
        held->push_back(std::move(job));
    }

    /** Worker-thread loop: run queued jobs in submission order until stopped. */
    void runLoop()
    {
        for (;;) {
            std::function<void()> job;
            std::deque<std::function<void()>> dropped;
            {
                QMutexLocker lock(&m_mutex);
                while (m_queue.empty() && !m_stopping) m_wake.wait(&m_mutex);
                if (m_stopping) {
                    // Shutdown began: the body in flight is the last one that may run against
                    // application state. Queued bodies are network commands that would extend
                    // the exit past the host's budget, so they are dropped here (the worker
                    // still owns the queue at this point, which keeps the single-owner rule).
                    // They are destroyed outside the lock, while the services they captured are
                    // still alive — unlike a post-teardown destruction.
                    dropped.swap(m_queue);
                    job = nullptr;
                } else {
                    job = std::move(m_queue.front());
                    m_queue.pop_front();
                }
            }
            if (!job) return;
            job();
        }
    }

private:
    class Worker : public QThread {
    public:
        explicit Worker(SerialExecutor *owner) : m_owner(owner) {}
        void run() override { m_owner->runLoop(); }

    private:
        SerialExecutor *m_owner;
    };

    SerialExecutor()
    {
        auto *worker = new Worker(this);
        worker->setObjectName(QStringLiteral("pideck-domain"));
        m_thread = worker;
        worker->start();
    }

    mutable QMutex m_mutex;
    QWaitCondition m_wake;
    std::deque<std::function<void()>> m_queue;
    bool m_stopping = false;
    /** Set once drainAndStop joined the worker (or found it never started). */
    bool m_joined = false;
    std::atomic<bool> m_abandoned{false};
    QThread *m_thread = nullptr;
};

struct Job {
    std::function<QJsonValue()> task;
    std::function<void(Outcome)> continuation;
    Outcome outcome;
};

} // namespace

void runBlocking(std::function<QJsonValue()> task, std::function<void(Outcome)> continuation)
{
    auto job = std::make_shared<Job>();
    job->task = std::move(task);
    job->continuation = std::move(continuation);
    SerialExecutor::instance().submit([job]() {
        try {
            job->outcome.value = job->task();
            job->outcome.ok = true;
        } catch (const std::exception &error) {
            job->outcome.ok = false;
            job->outcome.error = QString::fromUtf8(error.what());
        } catch (...) {
            job->outcome.ok = false;
            job->outcome.error = QStringLiteral("Background work failed");
        }
        job->task = nullptr;
        SerialExecutor &executor = SerialExecutor::instance();
        if (executor.abandoned()) {
            // The drain deadline is gone: the process is exiting and the services this
            // continuation captures may already be destroyed. Never run it, and do not destroy
            // it here either (see SerialExecutor::quarantine).
            executor.quarantine(std::shared_ptr<void>(std::move(job)));
            return;
        }
        if (executor.stopping()) {
            // Shutdown already started but the body finished inside the drain budget: the event
            // loop is about to stop, so dropping the completion here (while the services are
            // still alive) is the last safe moment. Posting it would leave the payload in the
            // queue to be destroyed after teardown.
            return;
        }
        QCoreApplication *application = QCoreApplication::instance();
        if (!application) return;
        // Settle on the thread that owns the responder. The context object is the
        // application instance, which always lives in the main thread.
        QMetaObject::invokeMethod(
            application,
            [job]() {
                if (job->continuation) job->continuation(job->outcome);
                job->continuation = nullptr;
            },
            Qt::QueuedConnection);
    });
}

bool drainAndStop(int timeoutMs)
{
    return SerialExecutor::instance().drainAndStop(timeoutMs);
}

bool abandoned()
{
    return SerialExecutor::instance().abandoned();
}

} // namespace background
