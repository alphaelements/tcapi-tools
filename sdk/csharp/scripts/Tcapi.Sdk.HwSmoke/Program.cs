// Hardware smoke test — requires a connected Tcapi-DIO device (proto=2).
// Run: dotnet run --project Tcapi.Sdk.HwSmoke
// Mirrors sdk/rust/tests/hw_smoke.rs; restores the RAM pin map on exit.

using Tcapi.Sdk;

var detailed = Discovery.DiscoverDetailed();
Check(detailed.Failures.Count == 0,
    $"probe failures: {string.Join(", ", detailed.Failures.Select(f => $"{f.Port}: {f.Error.Message}"))}");
var devices = detailed.Devices;
Check(devices.Count > 0, "no Tcapi-DIO found");
Console.WriteLine("discovered: " + string.Join(", ", devices.Select(WireJson.Serialize)));

// A Debugprobe (2e8a:000c) on the same host must NOT be detected. Its tty
// number depends on plug order, so locate it via sysfs instead of
// hard-coding a port name.
var debugprobePorts = DebugprobePorts();
Console.WriteLine("debugprobe ports: " + string.Join(", ", debugprobePorts));
Check(devices.All(d => !debugprobePorts.Contains(d.Port)), "Debugprobe misdetected");

// GP0-GP11 outputs, everything else an input with pull-down and edge events.
const uint outputMask = 0x0000_0FFF;
const uint inputMask = Pins.ValidDioMask & ~outputMask;
var testMap = new PinMap(
    Flags: 0, Direction: outputMask, PullUp: 0, PullDown: inputMask, OutDefault: 0,
    OutPolarity: 0, InPolarity: 0, Edge: inputMask);

var device = devices[0];
using (var conn = Connection.Open(device.Port))
{
    Console.WriteLine("firmware: " + WireJson.Serialize(conn.Firmware));
    Check(conn.Firmware.ProtocolVersion == Pins.ProtoVersion, "unexpected protocol");
    var caps = conn.Caps();
    Console.WriteLine($"caps: {WireJson.Serialize(caps)} has_sync: {caps.HasSync}");
    Check(caps.Dio == Pins.DioChannels, "unexpected dio count");
    Check(caps.TickNs == Pins.PatternTickNs, "unexpected pattern tick");
    Check(conn.Info().Uid == device.Uid, "info uid mismatch");
    Check(conn.Ping(0xC0FFEE) == 0xC0FFEE, "ping did not echo");

    var originalMap = conn.MapGet();
    Console.WriteLine("original map: " + WireJson.Serialize(originalMap));

    conn.MapSet(testMap);
    Check(conn.MapGet() == testMap, "map set not applied");
    var applied = conn.Caps();
    Check(applied.Out == 12 && applied.In == 13, "caps do not follow the map");

    conn.Write(0x0A5, outputMask);
    var state = conn.State();
    Console.WriteLine("state after write 0x0A5: " + WireJson.Serialize(state));
    Check((state.Outputs & outputMask) == 0x0A5, "outputs mismatch after write");
    conn.Write(0, outputMask);

    var total = conn.PatternLoad(
    [
        new PatternStep(OutBits: 0x00F, HoldTicks: PatternStep.HoldTicksFromNs(200_000)),
        new PatternStep(OutBits: 0x000, HoldTicks: PatternStep.HoldTicksFromNs(200_000)),
        new PatternStep(OutBits: 0x0F0, HoldTicks: PatternStep.HoldTicksFromNs(200_000)),
        new PatternStep(OutBits: 0x000, HoldTicks: PatternStep.HoldTicksFromNs(200_000)),
    ]);
    Check(total == 4, $"total={total}, expected 4");
    conn.PatternRun(PatternMode.Once, 1);
    Thread.Sleep(50);
    var afterOnce = conn.PatternStatus();
    Console.WriteLine("pattern status after once: " + WireJson.Serialize(afterOnce));
    Check(afterOnce.State != PatternState.Running, "pattern still running after once");
    // There is no infinite mode: use a large count and stop.
    conn.PatternRun(PatternMode.Loop, 1000);
    Thread.Sleep(20);
    Check(conn.PatternStatus().State == PatternState.Running, "loop not running");
    conn.PatternStop();
    Check(conn.PatternStatus().State != PatternState.Running, "stop did not stop");
    conn.PatternReset();

    conn.TsArm(0x00FF_F000, EdgeMode.Both);
    var result = conn.TsGet(Protocol.MaxTsGetEvents);
    Console.WriteLine($"ts events without stimulus: {result.Events.Count}");
    conn.TsDisarm();
    conn.Read(); // connection healthy after a counted read

    // The SDK owns `subscribe`: attaching turns it on, detaching turns it off.
    using (conn.Events.Subscribe(new NullObserver()))
    {
        conn.Read();
    }

    conn.SyncMaster();
    conn.SyncStart();
    var c1 = conn.SyncCount();
    Thread.Sleep(10);
    var c2 = conn.SyncCount();
    Console.WriteLine($"sync counts: {c1} -> {c2}");
    Check(c2 > c1, "sync clock not advancing");
    conn.SyncStop();
    conn.SyncDisarm();

    var raw = conn.Raw("version");
    Check(raw.Count == 1 && raw[0].StartsWith("OK ", StringComparison.Ordinal), $"raw response: {string.Join(" | ", raw)}");

    conn.MapSet(originalMap);
    Check(conn.MapGet() == originalMap, "map restore failed");

    Console.WriteLine("hw_smoke: all steps passed");
}

return 0;

// Serial ports belonging to a Raspberry Pi Debugprobe (VID 2e8a / PID 000c),
// resolved through /sys/class/tty the same way Discovery enumerates.
static List<string> DebugprobePorts()
{
    var ports = new List<string>();
    foreach (var entry in Directory.GetDirectories("/sys/class/tty"))
    {
        var real = new DirectoryInfo(entry)
            .ResolveLinkTarget(returnFinalTarget: true)?.FullName ?? entry;
        var idDir = Path.GetFullPath(Path.Combine(real, "..", "..", ".."));
        var vidPath = Path.Combine(idDir, "idVendor");
        var pidPath = Path.Combine(idDir, "idProduct");
        if (File.Exists(vidPath) && File.Exists(pidPath)
            && File.ReadAllText(vidPath).Trim() == "2e8a"
            && File.ReadAllText(pidPath).Trim() == "000c")
        {
            ports.Add("/dev/" + Path.GetFileName(entry));
        }
    }

    return ports;
}

static void Check(bool condition, string message)
{
    if (!condition)
    {
        throw new InvalidOperationException($"SMOKE FAIL: {message}");
    }
}

internal sealed class NullObserver : IObserver<PushEvent>
{
    public void OnNext(PushEvent value) => Console.WriteLine("event: " + value);

    public void OnCompleted()
    {
    }

    public void OnError(Exception error)
    {
    }
}
