using System.Text;

namespace Pochi.Sdk.Tests;

/// <summary>Duplex in-memory port satisfying <see cref="IDuplexPort"/>.
/// <see cref="Read"/> blocks up to the poll interval; <see cref="Feed"/>
/// injects device → host lines; written host → device lines invoke
/// <see cref="OnCommand"/>. Mirrors the Python <c>fake_port.py</c> /
/// Rust PTY MockFw harness.</summary>
internal sealed class FakePort : IDuplexPort
{
    private readonly object _lock = new();
    private readonly Queue<byte> _rx = new();
    private string _writeAcc = "";
    private volatile bool _closed;

    public List<string> Written { get; } = [];

    public Action<string>? OnCommand { get; set; }

    public bool Closed
    {
        get => _closed;
        set
        {
            lock (_lock)
            {
                _closed = value;
                Monitor.PulseAll(_lock);
            }
        }
    }

    public int Read(byte[] buffer, int offset, int count)
    {
        lock (_lock)
        {
            if (_closed)
            {
                throw new IOException("port closed");
            }

            if (_rx.Count == 0)
            {
                Monitor.Wait(_lock, 50);
                if (_closed)
                {
                    throw new IOException("port closed");
                }

                if (_rx.Count == 0)
                {
                    return 0;
                }
            }

            var n = Math.Min(count, _rx.Count);
            for (var i = 0; i < n; i++)
            {
                buffer[offset + i] = _rx.Dequeue();
            }

            return n;
        }
    }

    public void Write(byte[] buffer, int offset, int count)
    {
        if (_closed)
        {
            throw new IOException("port closed");
        }

        var commands = new List<string>();
        lock (_lock)
        {
            _writeAcc += Encoding.UTF8.GetString(buffer, offset, count);
            int idx;
            while ((idx = _writeAcc.IndexOf('\n')) >= 0)
            {
                var line = _writeAcc[..idx].TrimEnd('\r');
                _writeAcc = _writeAcc[(idx + 1)..];
                Written.Add(line);
                commands.Add(line);
            }
        }

        foreach (var command in commands)
        {
            OnCommand?.Invoke(command);
        }
    }

    public void Dispose() => Closed = true;

    /// <summary>Simulate device → host lines.</summary>
    public void Feed(params string[] lines)
    {
        lock (_lock)
        {
            foreach (var line in lines)
            {
                foreach (var b in Encoding.UTF8.GetBytes(line + "\r\n"))
                {
                    _rx.Enqueue(b);
                }
            }

            Monitor.PulseAll(_lock);
        }
    }

    /// <summary>Simulate device → host raw bytes (no line ending added).</summary>
    public void FeedRaw(string data)
    {
        lock (_lock)
        {
            foreach (var b in Encoding.UTF8.GetBytes(data))
            {
                _rx.Enqueue(b);
            }

            Monitor.PulseAll(_lock);
        }
    }
}
