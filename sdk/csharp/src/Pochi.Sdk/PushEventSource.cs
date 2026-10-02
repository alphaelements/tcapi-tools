namespace Pochi.Sdk;

/// <summary>Thread-safe multicast source backing
/// <see cref="Connection.Events"/>. Events are published from the transport
/// reader thread; observers receive them on that thread. Implemented
/// in-house to keep the SDK dependency-free (no System.Reactive).
///
/// The source owns the device subscription (R-H4): <c>onFirstSubscriber</c>
/// runs when the subscriber count goes 0 to 1 (<c>subscribe on</c>) and
/// <c>onLastUnsubscribed</c> when it goes 1 to 0 (<c>subscribe off</c>). There
/// is one device subscription however many subscribers share it.</summary>
internal sealed class PushEventSource(Action onFirstSubscriber, Action onLastUnsubscribed)
    : IObservable<PushEvent>
{
    // _gate serialises subscribe/unsubscribe including the device command it
    // may send; _lock only guards the observer list. They are separate so the
    // reader thread (Publish takes _lock only) never waits behind a command
    // that is waiting for the reader thread.
    private readonly object _gate = new();
    private readonly object _lock = new();
    private readonly List<IObserver<PushEvent>> _observers = [];
    private bool _completed;

    /// <summary>Attach <paramref name="observer"/>. The first subscriber turns
    /// the device subscription on; if the device refuses, the observer is not
    /// attached and the error is thrown.</summary>
    public IDisposable Subscribe(IObserver<PushEvent> observer)
    {
        ArgumentNullException.ThrowIfNull(observer);
        lock (_gate)
        {
            bool first;
            lock (_lock)
            {
                if (_completed)
                {
                    observer.OnCompleted();
                    return EmptyDisposable.Instance;
                }

                first = _observers.Count == 0;
                _observers.Add(observer);
            }

            if (first)
            {
                try
                {
                    onFirstSubscriber();
                }
                catch
                {
                    lock (_lock)
                    {
                        _observers.Remove(observer);
                    }

                    throw;
                }
            }
        }

        return new Subscription(this, observer);
    }

    public void Publish(PushEvent ev)
    {
        IObserver<PushEvent>[] snapshot;
        lock (_lock)
        {
            snapshot = _observers.ToArray();
        }

        foreach (var observer in snapshot)
        {
            observer.OnNext(ev);
        }
    }

    /// <summary>End the stream (connection closed). Observers complete; no
    /// <c>subscribe off</c> is sent because the connection is gone.</summary>
    public void Complete()
    {
        IObserver<PushEvent>[] snapshot;
        lock (_lock)
        {
            if (_completed)
            {
                return;
            }

            _completed = true;
            snapshot = _observers.ToArray();
            _observers.Clear();
        }

        foreach (var observer in snapshot)
        {
            observer.OnCompleted();
        }
    }

    private void Unsubscribe(IObserver<PushEvent> observer)
    {
        lock (_gate)
        {
            bool last;
            lock (_lock)
            {
                last = _observers.Remove(observer) && _observers.Count == 0 && !_completed;
            }

            if (last)
            {
                onLastUnsubscribed();
            }
        }
    }

    private sealed class Subscription(PushEventSource source, IObserver<PushEvent> observer)
        : IDisposable
    {
        private int _disposed;

        public void Dispose()
        {
            if (Interlocked.Exchange(ref _disposed, 1) == 0)
            {
                source.Unsubscribe(observer);
            }
        }
    }

    private sealed class EmptyDisposable : IDisposable
    {
        public static readonly EmptyDisposable Instance = new();

        public void Dispose()
        {
        }
    }
}
