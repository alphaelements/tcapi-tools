namespace Pochi.Sdk;

/// <summary>Thread-safe multicast source backing
/// <see cref="Connection.Events"/>. Events are published from the transport
/// reader thread; observers receive them on that thread. Implemented
/// in-house to keep the SDK dependency-free (no System.Reactive).</summary>
internal sealed class PushEventSource : IObservable<PushEvent>
{
    private readonly object _lock = new();
    private readonly List<IObserver<PushEvent>> _observers = [];
    private bool _completed;

    public IDisposable Subscribe(IObserver<PushEvent> observer)
    {
        ArgumentNullException.ThrowIfNull(observer);
        lock (_lock)
        {
            if (_completed)
            {
                observer.OnCompleted();
                return EmptyDisposable.Instance;
            }

            _observers.Add(observer);
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

    private sealed class Subscription(PushEventSource source, IObserver<PushEvent> observer)
        : IDisposable
    {
        public void Dispose()
        {
            lock (source._lock)
            {
                source._observers.Remove(observer);
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
