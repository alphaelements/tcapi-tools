using System.Collections.Concurrent;
using System.IO.Ports;
using System.Text;

namespace Pochi.Sdk;

/// <summary>Minimal duplex-port surface the transport needs. Satisfied by
/// the SerialPort adapter and the in-memory fake used in tests.</summary>
public interface IDuplexPort : IDisposable
{
    /// <summary>Read up to <paramref name="count"/> bytes. Returns 0 when the
    /// poll interval elapses with no data; throws on fatal I/O errors
    /// (device gone, port closed).</summary>
    int Read(byte[] buffer, int offset, int count);

    void Write(byte[] buffer, int offset, int count);
}

internal sealed class SerialDuplexPort : IDuplexPort
{
    private readonly SerialPort _port;

    private SerialDuplexPort(SerialPort port)
    {
        _port = port;
    }

    public static SerialDuplexPort Open(string path)
    {
        var port = new SerialPort(path, Transport.BaudRate)
        {
            ReadTimeout = (int)Transport.ReadPollInterval.TotalMilliseconds,
            WriteTimeout = 1000,
            // CDC firmware may gate output on the host asserting DTR
            // (pyserial and node-serialport assert both by default).
            DtrEnable = true,
            RtsEnable = true,
        };
        try
        {
            port.Open();
        }
        catch (Exception ex)
        {
            throw new SdkException(
                ErrorCode.Io, $"failed to open serial port {path}: {ex.Message}", ex);
        }

        return new SerialDuplexPort(port);
    }

    public int Read(byte[] buffer, int offset, int count)
    {
        try
        {
            return _port.Read(buffer, offset, count);
        }
        catch (TimeoutException)
        {
            return 0;
        }
    }

    public void Write(byte[] buffer, int offset, int count) =>
        _port.Write(buffer, offset, count);

    public void Dispose() => _port.Dispose();
}

/// <summary>
/// Serial transport: line-oriented command/response exchange with push
/// event multiplexing. Mirrors <c>sdk/rust/src/transport.rs</c>.
///
/// A background reader thread owns the read half of the port. It splits the
/// byte stream into lines and routes them: push lines (<c>! ...</c>) go to
/// the event callback, everything else goes to the response queue, so a push
/// event arriving mid-command never corrupts response parsing.
///
/// Two read disciplines exist and must stay separate:
/// <see cref="Command"/> — exactly one response line (OK/ERR); and
/// <see cref="CommandCounted"/> — <c>OK count=N</c> followed by exactly N
/// data lines (only <c>ts get</c>). Using a counted read on a single-line
/// command (e.g. <c>sync count</c>) would hang until timeout; using a plain
/// read on <c>ts get</c> would leave N lines behind. Never unify them.
/// </summary>
public sealed class Transport : IDisposable
{
    /// <summary>Conventional baud rate. Irrelevant for USB CDC but required by the API.</summary>
    public const int BaudRate = 115_200;

    /// <summary>Default time to wait for a command response.</summary>
    public static readonly TimeSpan DefaultCommandTimeout = TimeSpan.FromSeconds(2);

    /// <summary>Poll interval of the reader thread (also bounds shutdown latency).</summary>
    internal static readonly TimeSpan ReadPollInterval = TimeSpan.FromMilliseconds(50);

    private readonly IDuplexPort _port;
    private readonly BlockingCollection<string> _responses = new();
    private readonly object _eventLock = new();
    private readonly ManualResetEventSlim _disconnected = new(false);
    private readonly Thread _reader;
    private Action<PushEvent>? _eventCallback;
    private volatile bool _shutdown;
    private bool _closed;

    /// <summary>Command response timeout (default 2 seconds).</summary>
    public TimeSpan CommandTimeout { get; set; } = DefaultCommandTimeout;

    public Transport(IDuplexPort port)
    {
        _port = port;
        _reader = new Thread(ReaderLoop) { IsBackground = true, Name = "pochi-reader" };
        _reader.Start();
    }

    /// <summary>Open the serial port at <paramref name="path"/> and start
    /// the reader thread.</summary>
    public static Transport Open(string path) => new(SerialDuplexPort.Open(path));

    /// <summary>Install a push event subscriber (replaces any previous one).
    /// Push events arriving with no subscriber installed are discarded.
    /// The callback runs on the reader thread — keep it short.</summary>
    public void SetEventCallback(Action<PushEvent>? callback)
    {
        lock (_eventLock)
        {
            _eventCallback = callback;
        }
    }

    /// <summary>Send a command expecting a single OK/ERR response line.</summary>
    public string Command(string cmd)
    {
        DrainStaleResponses();
        WriteLine(cmd);
        var line = RecvResponse(CommandTimeout);
        return Protocol.ParseResponse(line).OkData();
    }

    /// <summary>Send a command whose response is <c>OK count=N</c> followed
    /// by exactly N data lines (<c>ts get</c> only).</summary>
    public (string Data, IReadOnlyList<string> Lines) CommandCounted(string cmd)
    {
        DrainStaleResponses();
        WriteLine(cmd);

        var first = RecvResponse(CommandTimeout);
        var data = Protocol.ParseResponse(first).OkData();
        var count = Protocol.ParseCountField(data);

        // Per-line budget: large captures (e.g. ts get on a full ring) stream
        // many data lines and the USB CDC scheduler may pace them slower than
        // a single command-level timeout allows. Reset the budget for each
        // line so a slow stream does not trip the OK-line timeout.
        var lines = new List<string>();
        for (var i = 0UL; i < count; i++)
        {
            lines.Add(RecvResponse(CommandTimeout));
        }

        return (data, lines);
    }

    /// <summary>Send an arbitrary command and return the raw first response
    /// line (OK/ERR as received, unparsed). Stale extra lines are discarded
    /// before the next command.</summary>
    public string Raw(string cmd)
    {
        DrainStaleResponses();
        WriteLine(cmd);
        return RecvResponse(CommandTimeout);
    }

    /// <summary>Stop the reader thread and close the port.</summary>
    public void Close()
    {
        if (_closed)
        {
            return;
        }

        _closed = true;
        _shutdown = true;
        _reader.Join(TimeSpan.FromSeconds(2));
        try
        {
            _port.Dispose();
        }
        catch (Exception ex)
        {
            throw new SdkException(ErrorCode.Io, $"failed to close port: {ex.Message}", ex);
        }
    }

    public void Dispose() => Close();

    // --- internals ---

    private void WriteLine(string cmd)
    {
        if (_disconnected.IsSet)
        {
            throw new SdkException(ErrorCode.Disconnected, "device disconnected");
        }

        var data = Encoding.UTF8.GetBytes(cmd + "\r\n");
        try
        {
            _port.Write(data, 0, data.Length);
        }
        catch (Exception ex)
        {
            // A write failure usually means the device is gone; give the
            // reader thread a moment to confirm so the error is uniform.
            if (_disconnected.Wait(TimeSpan.FromMilliseconds(300)))
            {
                throw new SdkException(ErrorCode.Disconnected, "device disconnected", ex);
            }

            throw new SdkException(ErrorCode.Io, $"write failed: {ex.Message}", ex);
        }
    }

    private string RecvResponse(TimeSpan timeout)
    {
        var deadline = Environment.TickCount64
            + (long)Math.Max(timeout.TotalMilliseconds, 0);
        while (true)
        {
            var remaining = deadline - Environment.TickCount64;
            if (remaining <= 0)
            {
                if (_disconnected.IsSet)
                {
                    throw new SdkException(ErrorCode.Disconnected, "device disconnected");
                }

                throw new SdkException(ErrorCode.Timeout, "timeout waiting for response");
            }

            // Wake periodically so a disconnect surfaces promptly instead
            // of after the full command timeout.
            if (_responses.TryTake(out var line, (int)Math.Min(remaining, 50)))
            {
                return line;
            }

            if (_disconnected.IsSet && _responses.Count == 0)
            {
                throw new SdkException(ErrorCode.Disconnected, "device disconnected");
            }
        }
    }

    /// <summary>Discard response lines left over from a previous timed-out
    /// or raw exchange so they cannot be mistaken for the next response.</summary>
    private void DrainStaleResponses()
    {
        while (_responses.TryTake(out _))
        {
        }
    }

    private void ReaderLoop()
    {
        var buffer = new byte[256];
        var acc = new List<byte>();
        while (!_shutdown)
        {
            int n;
            try
            {
                n = _port.Read(buffer, 0, buffer.Length);
            }
            catch
            {
                break; // fatal I/O error: device gone
            }

            if (n <= 0)
            {
                continue;
            }

            for (var i = 0; i < n; i++)
            {
                acc.Add(buffer[i]);
            }

            int idx;
            while ((idx = acc.IndexOf((byte)'\n')) >= 0)
            {
                var raw = acc.GetRange(0, idx + 1).ToArray();
                acc.RemoveRange(0, idx + 1);
                var line = Encoding.UTF8.GetString(raw).TrimEnd('\r', '\n');
                if (line.Length == 0)
                {
                    continue;
                }

                if (line.StartsWith("! ", StringComparison.Ordinal))
                {
                    DispatchEvent(line[2..]);
                }
                else
                {
                    _responses.Add(line);
                }
            }
        }

        _disconnected.Set();
    }

    private void DispatchEvent(string payload)
    {
        Action<PushEvent>? callback;
        lock (_eventLock)
        {
            callback = _eventCallback;
        }

        if (callback is null)
        {
            return;
        }

        // A malformed known-type event is delivered as UnknownEvent rather
        // than dropped: losing the line silently would hide FW mismatches.
        PushEvent ev;
        try
        {
            ev = Protocol.ParsePushEvent(payload);
        }
        catch (Exception ex)
        {
            ev = new UnknownEvent($"{payload} (parse error: {ex.Message})");
        }

        callback(ev);
    }
}
