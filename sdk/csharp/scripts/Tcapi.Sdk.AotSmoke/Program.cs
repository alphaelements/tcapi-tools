using Tcapi.Sdk;

// NativeAOT smoke test of the SDK surface that has a trimming/AOT risk:
// source-generated wire JSON, the hand-written TOML parser, a full
// handshake + command over an in-memory port, and the real SerialPort open
// path (failing on purpose: no hardware is needed). Exit code 0 = all fine.

static void Check(bool condition, string what)
{
    if (!condition)
    {
        Console.Error.WriteLine($"FAIL: {what}");
        Environment.Exit(1);
    }

    Console.WriteLine($"ok: {what}");
}

// 1. Wire JSON (System.Text.Json source generation).
var info = new DeviceInfo("AABBCCDD11223344", null, "/dev/ttyACM0", "0.1.3");
var json = WireJson.Serialize(info);
Check(json == "{\"uid\":\"AABBCCDD11223344\",\"device_number\":null,"
    + "\"port\":\"/dev/ttyACM0\",\"version\":\"0.1.3\"}", "wire JSON serialize");
Check(WireJson.Deserialize<DeviceInfo>(json) == info, "wire JSON round trip");
Check(WireJson.Serialize(SyncState.MasterArmed) == "\"master_armed\"", "wire JSON enum");

// 2. TOML configuration (hand-written parser).
var safety = Config.ParseSafety(
    "version = 2\n[watchdog]\ntimeout_ms = 500\n[usb]\nsafe = true\n", "safety.toml");
Check(safety.WatchdogMs == 500 && safety.UsbSafe, "safety.toml parse");

// 3. Handshake and a command over an in-memory port.
using (var conn = Connection.FromPort(new LoopbackPort()))
{
    Check(conn.Firmware.ProtocolVersion == 2, "handshake over an in-memory port");
    Check(conn.Ping(7) == 7, "ping over an in-memory port");
}

// 4. The real serial open path (System.IO.Ports) on a path that cannot exist.
var opened = Connection.TryOpen("/dev/tcapi-aot-smoke-missing", out var ignored, out var error);
Check(!opened && ignored is null && error is { Code: ErrorCode.Io }, "serial open failure is a typed error");
Console.WriteLine($"    ({error?.Message})");

// 5. The same failure with the port path kept out of the error.
var hidden = new ConnectionOptions { OmitPortPathFromErrors = true };
Connection.TryOpen("/dev/tcapi-aot-smoke-missing", out _, out var hiddenError, hidden);
Check(hiddenError is { InnerException: null } && !hiddenError.Message.Contains("tcapi-aot-smoke"),
    "port path omitted from the error");

// 6. Result type and cancellation.
using var cts = new CancellationTokenSource();
cts.Cancel();
using (var conn = Connection.FromPort(new LoopbackPort()))
{
    Check(conn.Try(c => c.Ping(1)).IsOk, "result-typed command");
    var cancelled = false;
    try { conn.Ping(2, cts.Token); } catch (OperationCanceledException) { cancelled = true; }
    Check(cancelled, "cancelled token ends the command");
}

return 0;

/// <summary>Answers <c>version</c> and <c>ping</c> like a device.</summary>
internal sealed class LoopbackPort : IDuplexPort
{
    private readonly object _lock = new();
    private readonly Queue<byte> _rx = new();
    private string _tx = "";
    private bool _closed;

    public int Read(byte[] buffer, int offset, int count)
    {
        lock (_lock)
        {
            if (_closed)
            {
                throw new IOException("closed");
            }

            if (_rx.Count == 0)
            {
                Monitor.Wait(_lock, 50);
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
        lock (_lock)
        {
            _tx += System.Text.Encoding.UTF8.GetString(buffer, offset, count);
            int idx;
            while ((idx = _tx.IndexOf('\n')) >= 0)
            {
                var line = _tx[..idx].TrimEnd('\r');
                _tx = _tx[(idx + 1)..];
                var reply = line == "version"
                    ? "OK fw=0.1.3 proto=2"
                    : line.StartsWith("ping ", StringComparison.Ordinal)
                        ? "OK pong=" + line[5..]
                        : "ERR UNKNOWN_CMD";
                foreach (var b in System.Text.Encoding.UTF8.GetBytes(reply + "\r\n"))
                {
                    _rx.Enqueue(b);
                }
            }

            Monitor.PulseAll(_lock);
        }
    }

    public void Dispose()
    {
        lock (_lock)
        {
            _closed = true;
            Monitor.PulseAll(_lock);
        }
    }
}
