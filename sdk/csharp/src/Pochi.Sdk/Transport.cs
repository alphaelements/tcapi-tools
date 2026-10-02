using System.Collections.Concurrent;
using System.Diagnostics;
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
            // The device sends no events while DTR is deasserted, and drops
            // back to text mode when DTR falls: assert it on open (R-H3).
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
/// event multiplexing. Mirrors <c>sdk/rust/src/transport.rs</c> and implements
/// the transport contract of docs/sdk-api-design.md (R-H1 to R-H4).
///
/// A background reader thread owns the read half of the port. It splits the
/// byte stream into lines and routes them: push lines (<c>! ...</c>) go to
/// the event callback, everything else goes to the response queue, so a push
/// event arriving mid-command never corrupts response parsing.
///
/// One command produces exactly one response: a single <c>OK</c>/<c>ERR</c>
/// line (<see cref="Command"/>) or a header with <c>count=N</c> followed by
/// exactly N lines (<see cref="CommandCounted"/>, <see cref="Raw"/>). There is
/// no draining of "extra" lines. A timeout, an unparseable line or a short
/// counted response leaves the connection out of step ("desync"); the next
/// operation first resynchronises with <c>ping &lt;random u32&gt;</c> and
/// closes the connection if that fails.
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
    private readonly object _commandLock = new();
    private readonly object _eventLock = new();
    private readonly ManualResetEventSlim _disconnected = new(false);
    private readonly Thread _reader;
    private Action<PushEvent>? _eventCallback;
    private volatile bool _shutdown;
    private bool _closed;
    private bool _desync;

    /// <summary>Command response timeout (default 2 seconds).</summary>
    public TimeSpan CommandTimeout { get; set; } = DefaultCommandTimeout;

    /// <summary>Receives every error the transport has no caller to throw to:
    /// an unknown or malformed event line (discarded) and an exception thrown
    /// by an event subscriber. When null the message goes to
    /// <see cref="Trace.TraceError(string)"/>.</summary>
    public Action<string>? ErrorLog { get; set; }

    /// <summary>Raised on the reader thread when the reader stops: the device
    /// went away, the port failed, or the transport was closed.</summary>
    internal Action? Closed { get; set; }

    /// <summary>Response lines queued with no command waiting for them.</summary>
    internal int PendingResponses => _responses.Count;

    /// <summary>True when the next operation will resynchronise first.</summary>
    internal bool IsDesynced
    {
        get
        {
            lock (_commandLock)
            {
                return _desync;
            }
        }
    }

    public Transport(IDuplexPort port)
    {
        _port = port;
        _reader = new Thread(ReaderLoop) { IsBackground = true, Name = "pochi-reader" };
        _reader.Start();
    }

    /// <summary>Open the serial port at <paramref name="path"/> (asserting DTR)
    /// and start the reader thread.</summary>
    public static Transport Open(string path) => new(SerialDuplexPort.Open(path));

    /// <summary>Install a push event subscriber (replaces any previous one).
    /// Push events arriving with no subscriber installed are discarded.
    /// The callback runs on the reader thread — keep it short, and do not
    /// send commands from it.</summary>
    public void SetEventCallback(Action<PushEvent>? callback)
    {
        lock (_eventLock)
        {
            _eventCallback = callback;
        }
    }

    /// <summary>Send a command expecting a single OK/ERR response line and
    /// return the OK data.</summary>
    public string Command(string cmd) =>
        Exchange(cmd, () => Protocol.ParseResponse(RecvResponse()).OkData());

    /// <summary>Send a command whose response is <c>OK count=N</c> followed
    /// by exactly N data lines (<c>ts get</c>, <c>help</c>). Returns the OK
    /// data and the N lines, which keep their two leading spaces.</summary>
    public (string Data, IReadOnlyList<string> Lines) CommandCounted(string cmd) =>
        Exchange(cmd, () =>
        {
            var data = Protocol.ParseResponse(RecvResponse()).OkData();
            return (data, ReadCountedLines(Protocol.ParseCountField(data)));
        });

    /// <summary>Send an arbitrary command and return <b>all</b> lines of the
    /// response under the same rules as every other command: one line
    /// (<c>OK ...</c> / <c>ERR ...</c>), or for a counted response the header
    /// and its N lines. The lines are returned as received, without CR/LF.</summary>
    public IReadOnlyList<string> Raw(string cmd) =>
        Exchange(cmd, () =>
        {
            var header = RecvResponse();
            var response = Protocol.ParseResponse(header);
            var lines = new List<string> { header };
            if (response.Kind == ResponseKind.Ok
                && Protocol.TryParseCountField(response.Data) is { } count)
            {
                lines.AddRange(ReadCountedLines(count));
            }

            return lines;
        });

    /// <summary>Stop the reader thread and close the port.</summary>
    public void Close()
    {
        if (_closed)
        {
            return;
        }

        _closed = true;
        _shutdown = true;
        if (Thread.CurrentThread != _reader)
        {
            _reader.Join(TimeSpan.FromSeconds(2));
        }

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

    /// <summary>Record that the response stream is out of step (for example
    /// because a response could not be interpreted); the next operation
    /// resynchronises first.</summary>
    internal void MarkDesync()
    {
        lock (_commandLock)
        {
            _desync = true;
        }
    }

    // --- internals ---

    /// <summary>Run one request/response exchange: serialise callers, check the
    /// request, resynchronise if needed, write the line and read the response
    /// with <paramref name="readResponse"/>. A timeout or a parse failure
    /// leaves the stream out of step.</summary>
    private T Exchange<T>(string cmd, Func<T> readResponse)
    {
        if (Thread.CurrentThread == _reader)
        {
            throw new InvalidOperationException(
                "commands cannot be sent from an event callback (reader thread)");
        }

        Protocol.CheckRequestLine(cmd);
        lock (_commandLock)
        {
            ResyncIfNeeded();
            WriteLine(cmd);
            try
            {
                return readResponse();
            }
            catch (SdkException ex) when (ex.Code is ErrorCode.Timeout or ErrorCode.Parse)
            {
                _desync = true;
                throw;
            }
        }
    }

    private List<string> ReadCountedLines(ulong count)
    {
        // Per-line budget: large captures (e.g. ts get on a full ring) stream
        // many data lines and the USB CDC scheduler may pace them slower than
        // a single command-level timeout allows. Reset the budget for each
        // line so a slow stream does not trip the OK-line timeout.
        var lines = new List<string>();
        for (var i = 0UL; i < count; i++)
        {
            lines.Add(RecvResponse());
        }

        return lines;
    }

    /// <summary>Re-establish "one command, one response" after a desync, or when
    /// a stale response line is queued while idle: send
    /// <c>ping &lt;random u32&gt;</c> and discard every response line until
    /// <c>OK pong=&lt;same value&gt;</c> arrives. Push events are routed to the
    /// event path by the reader meanwhile. If the pong never arrives the
    /// connection is closed.</summary>
    private void ResyncIfNeeded()
    {
        // A response line queued while no command is pending is stale (a late
        // answer of an earlier command); it must not become the next answer.
        if (!_desync && _responses.Count == 0)
        {
            return;
        }

        var token = unchecked((uint)Random.Shared.NextInt64(0, uint.MaxValue + 1L));
        var expected = $"OK pong={token}";
        WriteLine(Protocol.PingCommand(token));
        var deadline = Environment.TickCount64 + (long)CommandTimeout.TotalMilliseconds;
        while (true)
        {
            string line;
            try
            {
                line = RecvResponse(deadline);
            }
            catch (SdkException ex) when (ex.Code is ErrorCode.Timeout)
            {
                try
                {
                    Close();
                }
                catch (SdkException closeError)
                {
                    LogError($"closing after failed resynchronisation: {closeError.Message}");
                }

                throw new SdkException(
                    ErrorCode.Disconnected,
                    "resynchronisation failed (no ping reply); connection closed",
                    ex);
            }

            if (line == expected)
            {
                _desync = false;
                return;
            }
        }
    }

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

    private string RecvResponse() =>
        RecvResponse(Environment.TickCount64 + (long)CommandTimeout.TotalMilliseconds);

    private string RecvResponse(long deadlineTicks)
    {
        while (true)
        {
            var remaining = deadlineTicks - Environment.TickCount64;
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
            catch (Exception)
            {
                break; // closed locally or fatal I/O error: device gone
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
        try
        {
            Closed?.Invoke();
        }
        catch (Exception ex)
        {
            LogError($"close notification threw: {ex}");
        }
    }

    /// <summary>Route one push line. An unknown or malformed event is logged
    /// as an error and discarded: it is never delivered to a subscriber and
    /// never queued as a response.</summary>
    private void DispatchEvent(string payload)
    {
        PushEvent ev;
        try
        {
            ev = Protocol.ParsePushEvent(payload);
        }
        catch (SdkException ex)
        {
            LogError($"discarded event line \"! {payload}\": {ex.Message}");
            return;
        }

        Action<PushEvent>? callback;
        lock (_eventLock)
        {
            callback = _eventCallback;
        }

        if (callback is null)
        {
            return; // no subscriber installed
        }

        try
        {
            callback(ev);
        }
        catch (Exception ex)
        {
            // A faulty subscriber must not kill the reader thread.
            LogError($"event subscriber threw on \"! {payload}\": {ex}");
        }
    }

    private void LogError(string message)
    {
        var log = ErrorLog;
        if (log is null)
        {
            Trace.TraceError(message);
            return;
        }

        log(message);
    }
}
