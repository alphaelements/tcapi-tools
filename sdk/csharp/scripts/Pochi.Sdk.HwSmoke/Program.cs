// Hardware smoke test — requires a connected Pochi-DIO device.
// Run: dotnet run --project Pochi.Sdk.HwSmoke
// Mirrors sdk/rust/tests/hw_smoke.rs; restores device state on exit.

using Pochi.Sdk;

var detailed = Discovery.DiscoverDetailed();
Check(detailed.Failures.Count == 0,
    $"probe failures: {string.Join(", ", detailed.Failures.Select(f => $"{f.Port}: {f.Error.Message}"))}");
var devices = detailed.Devices;
Check(devices.Count > 0, "no Pochi-DIO found");
Console.WriteLine("discovered: " + string.Join(", ", devices.Select(WireJson.Serialize)));

// A Debugprobe (2e8a:000c) on the same host must NOT be detected. Its tty
// number depends on plug order, so locate it via sysfs instead of
// hard-coding a port name.
var debugprobePorts = DebugprobePorts();
Console.WriteLine("debugprobe ports: " + string.Join(", ", debugprobePorts));
Check(devices.All(d => !debugprobePorts.Contains(d.Port)), "Debugprobe misdetected");

var device = devices[0];
using (var conn = Connection.Open(device.Port))
{
    var version = conn.Version();
    Console.WriteLine("version: " + WireJson.Serialize(version));
    var caps = conn.Caps();
    Console.WriteLine($"caps: {WireJson.Serialize(caps)} has_sync: {caps.HasSync}");
    Check(caps.MaxDio == 23, "unexpected max_dio");
    Check(caps.TsResolutionNs != 1000, "old firmware");
    Check(conn.Info().Uid == device.Uid, "info uid mismatch");

    var originalMap = conn.MapGet();
    Console.WriteLine("original map: " + WireJson.Serialize(originalMap));

    conn.MapSet(new PinMap(
        Version: 1, OutBase: 0, OutCount: 12, InBase: 12, InCount: 11,
        Pull: PullMode.Up, Flags: 0x01));
    var active = conn.MapGet();
    Check(active.OutCount == 12 && active.InCount == 11, "map set not applied");

    conn.Write(0x0A5, 0xFFF);
    var state = conn.State();
    Console.WriteLine("state after write 0x0A5: " + WireJson.Serialize(state));
    Check((state.Outputs & 0xFFF) == 0x0A5, "outputs mismatch after write");
    conn.Write(0, 0xFFF);

    var accepted = conn.PatternLoad(
    [
        new PatternStep(OutBits: 0x00F, HoldUs: 1000),
        new PatternStep(OutBits: 0x000, HoldUs: 1000),
        new PatternStep(OutBits: 0x0F0, HoldUs: 1000),
        new PatternStep(OutBits: 0x000, HoldUs: 1000),
    ]);
    Check(accepted == 4, $"accepted={accepted}, expected 4");
    conn.PatternRun(PatternMode.Once, 1);
    Thread.Sleep(50);
    var afterOnce = conn.PatternStatus();
    Console.WriteLine("pattern status after once: " + WireJson.Serialize(afterOnce));
    Check(afterOnce.State != PatternState.Running, "pattern still running after once");
    // repeat=0 is BAD_PARAM on FW — no infinite mode.
    conn.PatternRun(PatternMode.Loop, 1000);
    Thread.Sleep(20);
    Check(conn.PatternStatus().State == PatternState.Running, "loop not running");
    conn.PatternStop();
    Check(conn.PatternStatus().State != PatternState.Running, "stop did not stop");

    conn.TsArm(0x07FF, EdgeMode.Both);
    var result = conn.TsGet(256);
    Console.WriteLine($"ts events without stimulus: {result.Events.Count}");
    conn.TsDisarm();
    conn.Read(); // connection healthy after counted read

    conn.Subscribe(true);
    conn.Subscribe(false);

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
    Check(raw.StartsWith("OK ", StringComparison.Ordinal), $"raw response: {raw}");

    conn.MapSet(originalMap);
    conn.MapSave();
    Check(conn.MapGet().OutCount == originalMap.OutCount, "map restore failed");

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
