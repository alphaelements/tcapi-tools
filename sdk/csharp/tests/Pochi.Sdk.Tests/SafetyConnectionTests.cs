using System.Globalization;
using Xunit;

namespace Pochi.Sdk.Tests;

/// <summary>A fake device whose answers come from a handler, for the
/// behaviour that depends on the sequence of commands (apply order, abort,
/// heartbeat). The shapes of the lines it prints are those of the golden
/// transcripts; the transcripts themselves are replayed by GoldenReplayTests.</summary>
internal sealed class ScriptedDevice
{
    private readonly Func<string, string[]?> _handler;
    private readonly object _lock = new();

    public ScriptedDevice(Func<string, string[]?> handler)
    {
        _handler = handler;
        Port.OnCommand = OnCommand;
    }

    public FakePort Port { get; } = new();

    /// <summary>Every command line received, without the opening <c>version</c>.</summary>
    public List<string> Commands()
    {
        lock (_lock)
        {
            return Port.Written.Skip(1).ToList();
        }
    }

    public Connection Connect(TimeSpan? timeout = null)
    {
        var conn = Connection.FromPort(Port);
        if (timeout is { } t)
        {
            conn.CommandTimeout = t;
        }

        return conn;
    }

    private void OnCommand(string line)
    {
        if (line == "version")
        {
            Port.Feed("OK fw=0.1.3 proto=2");
            return;
        }

        // null: the default answer (a pong for ping, UNKNOWN_CMD otherwise);
        // an empty array: no answer at all.
        var reply = _handler(line)
            ?? (line.StartsWith("ping ", StringComparison.Ordinal)
                ? ["OK pong=" + line[5..]]
                : ["ERR UNKNOWN_CMD"]);
        if (reply.Length > 0)
        {
            Port.Feed(reply);
        }
    }

    /// <summary>The state of a device that implements the safety commands.</summary>
    public sealed class SafetyModel
    {
        public uint WdogMs;
        public bool UsbSafe;
        public List<uint> Groups = [];
        public bool Failsafe;
        public string? Reject; // a command name answered with this ERR text instead
        public string? RejectCommand;

        public string[]? Handle(string line)
        {
            if (RejectCommand is not null && line.StartsWith(RejectCommand, StringComparison.Ordinal))
            {
                return [Reject!];
            }

            var w = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);
            switch (w)
            {
                case ["wdog", var ms]:
                    WdogMs = uint.Parse(ms, CultureInfo.InvariantCulture);
                    return ["OK"];
                case ["usbsafe", var onOff]:
                    UsbSafe = onOff == "on";
                    return ["OK"];
                case ["excl", "clear"]:
                    Groups = [];
                    return ["OK"];
                case ["excl", "set", .. var masks]:
                    Groups = masks
                        .Select(m => Convert.ToUInt32(m[2..], 16))
                        .ToList();
                    return ["OK"];
                case ["excl", "get"]:
                    return
                    [
                        $"OK count={Groups.Count}",
                        .. Groups.Select(g => $"  mask=0x{g:x8}"),
                    ];
                case ["safety"]:
                    return
                    [
                        $"OK wdog_ms={WdogMs} remaining_ms={WdogMs} failsafe={(Failsafe ? 1 : 0)} "
                            + $"cause={(Failsafe ? "wdog" : "none")} usbsafe={(UsbSafe ? 1 : 0)} "
                            + $"excl={Groups.Count}",
                    ];
                default:
                    return null;
            }
        }
    }
}

public class SafetyConnectionTests
{
    private static (ScriptedDevice Device, ScriptedDevice.SafetyModel Model) Safe()
    {
        var model = new ScriptedDevice.SafetyModel();
        return (new ScriptedDevice(model.Handle), model);
    }

    // --- single commands ---

    [Fact]
    public void EachCommandSendsItsWireForm()
    {
        var (device, model) = Safe();
        using var conn = device.Connect();
        conn.Wdog(500);
        conn.UsbSafe(true);
        conn.ExclSet([0xc, 0x18]);
        Assert.Equal([0xcU, 0x18U], conn.ExclGet());
        conn.ExclClear();
        Assert.Empty(conn.ExclGet());
        var state = conn.Safety();
        Assert.Equal(new SafetyState(500, 500, false, FailsafeCause.None, true, 0), state);
        Assert.Equal(
            [
                "wdog 500",
                "usbsafe on",
                "excl set 0xc 0x18",
                "excl get",
                "excl clear",
                "excl get",
                "safety",
            ],
            device.Commands());
        Assert.Equal(500U, model.WdogMs);
    }

    [Fact]
    public void UsbsafeOffAndTheBareCommandsHaveTheirOwnLines()
    {
        var device = new ScriptedDevice(line => line switch
        {
            "usbsafe off" or "failsafe clear" or "outputs reset" => ["OK"],
            "rstinfo" => ["OK cause=wdt uptime_ms=1234 boot=0x00000007"],
            "pads" => ["OK out=0x00000005 pad=0x00000001"],
            _ => null,
        });
        using var conn = device.Connect();
        conn.UsbSafe(false);
        conn.FailsafeClear();
        conn.OutputsReset();
        Assert.Equal(new ResetInfo(ResetCause.Wdt, 1234, 7), conn.RstInfo());
        Assert.Equal(new Pads(5, 1), conn.Pads());
        Assert.Equal(
            ["usbsafe off", "failsafe clear", "outputs reset", "rstinfo", "pads"],
            device.Commands());
    }

    [Fact]
    public void InvalidArgumentsAreRefusedBeforeAnythingIsSent()
    {
        var (device, _) = Safe();
        using var conn = device.Connect();
        TestHelpers.AssertSdkThrows(ErrorCode.InvalidArgument, () => conn.Wdog(99));
        TestHelpers.AssertSdkThrows(ErrorCode.InvalidArgument, () => conn.Wdog(10001));
        TestHelpers.AssertSdkThrows(ErrorCode.InvalidArgument, () => conn.ExclSet([]));
        TestHelpers.AssertSdkThrows(ErrorCode.InvalidArgument, () => conn.ExclSet([0x1]));
        Assert.Empty(device.Commands());
    }

    [Fact]
    public void DeviceErrorsKeepTheirCodes()
    {
        var device = new ScriptedDevice(line => line switch
        {
            "failsafe clear" => ["ERR BAD_PARAM"],
            "outputs reset" => ["ERR FAILSAFE"],
            "excl set 0xc" => ["ERR EXCLUSIVE group=0 mask=0x0000000c"],
            _ => null,
        });
        using var conn = device.Connect();
        TestHelpers.AssertSdkThrows(ErrorCode.BadParam, () => conn.FailsafeClear());
        TestHelpers.AssertSdkThrows(ErrorCode.Failsafe, () => conn.OutputsReset());
        var ex = Assert.Throws<ExclusiveException>(() => conn.ExclSet([0xc]));
        Assert.Equal(((byte)0, 0xcU), (ex.Group, ex.Mask));
    }

    [Fact]
    public void AMalformedSafetyAnswerIsAParseErrorAndTheNextCommandResynchronises()
    {
        var calls = 0;
        var device = new ScriptedDevice(line => line switch
        {
            "safety" => calls++ == 0
                ? ["OK wdog_ms=0 remaining_ms=0 failsafe=1 cause=none usbsafe=0 excl=0"]
                : ["OK wdog_ms=0 remaining_ms=0 failsafe=0 cause=none usbsafe=0 excl=0"],
            _ => null,
        });
        using var conn = device.Connect();
        TestHelpers.AssertSdkThrows(ErrorCode.Parse, () => conn.Safety());
        Assert.Equal(0U, conn.Safety().WdogMs);
        Assert.Contains(device.Commands(), c => c.StartsWith("ping ", StringComparison.Ordinal));
    }

    [Fact]
    public void FailsafeEventsReachSubscribers()
    {
        var device = new ScriptedDevice(line => line is "subscribe on" or "subscribe off" ? ["OK"] : null);
        using var conn = device.Connect();
        var got = new List<PushEvent>();
        using var sub = conn.Events.Subscribe(new CollectingObserver(got));
        device.Port.Feed("! FAILSAFE cause=usb");
        var deadline = Environment.TickCount64 + 2000;
        while (Environment.TickCount64 < deadline)
        {
            lock (got)
            {
                if (got.Count > 0)
                {
                    break;
                }
            }

            Thread.Sleep(5);
        }

        lock (got)
        {
            Assert.Equal([new FailsafeEvent(FailsafeCause.Usb)], got);
        }
    }

    private sealed class CollectingObserver(List<PushEvent> sink) : IObserver<PushEvent>
    {
        public void OnNext(PushEvent value)
        {
            lock (sink)
            {
                sink.Add(value);
            }
        }

        public void OnCompleted()
        {
        }

        public void OnError(Exception error)
        {
        }
    }

    // --- ApplySafety (config-files.md section 7, DD-16) ---

    [Fact]
    public void ApplySendsTheDd16OrderThenReadsBack()
    {
        var (device, _) = Safe();
        using var conn = device.Connect();
        var state = conn.ApplySafety(new SafetyConfig(800, true, [0xc, 0x18]));
        Assert.Equal(
            ["excl set 0xc 0x18", "usbsafe on", "wdog 800", "safety", "excl get"],
            device.Commands());
        Assert.Equal(800U, state.WdogMs);
        Assert.True(state.UsbSafe);
        Assert.Equal((byte)2, state.Excl);
    }

    [Fact]
    public void ApplyWithoutGroupsSendsExclClearAndNeverBeforeExclSet()
    {
        var (device, _) = Safe();
        using var conn = device.Connect();
        conn.ApplySafety(SafetyConfig.Default);
        Assert.Equal(
            ["excl clear", "usbsafe off", "wdog 0", "safety", "excl get"], device.Commands());

        var (device2, _) = Safe();
        using var conn2 = device2.Connect();
        conn2.ApplySafety(new SafetyConfig(0, false, [0x3]));
        Assert.DoesNotContain("excl clear", device2.Commands());
    }

    [Fact]
    public void ApplyValidatesFirstAndSendsNothing()
    {
        var (device, _) = Safe();
        using var conn = device.Connect();
        TestHelpers.AssertSdkThrows(
            ErrorCode.InvalidArgument, () => conn.ApplySafety(new SafetyConfig(99, false, [])));
        TestHelpers.AssertSdkThrows(
            ErrorCode.InvalidArgument, () => conn.ApplySafety(new SafetyConfig(0, false, [0x1])));
        Assert.Empty(device.Commands());
    }

    [Theory]
    [InlineData("excl set", ErrorCode.BadParam, "ERR BAD_PARAM", 1)]
    [InlineData("usbsafe", ErrorCode.Busy, "ERR BUSY", 2)]
    [InlineData("wdog", ErrorCode.BadParam, "ERR BAD_PARAM", 3)]
    public void TheFirstDeviceErrorStopsTheApplyWithItsCode(
        string failing, ErrorCode code, string reply, int sent)
    {
        var (device, model) = Safe();
        model.RejectCommand = failing;
        model.Reject = reply;
        using var conn = device.Connect();
        TestHelpers.AssertSdkThrows(
            code, () => conn.ApplySafety(new SafetyConfig(800, true, [0xc])));
        // Later commands are not sent and there is no read-back.
        var commands = device.Commands();
        Assert.Equal(sent, commands.Count);
        Assert.DoesNotContain("safety", commands);
        Assert.DoesNotContain("excl get", commands);
    }

    [Fact]
    public void AnExclusiveRefusalKeepsItsGroupAndMask()
    {
        var (device, model) = Safe();
        model.RejectCommand = "excl set";
        model.Reject = "ERR EXCLUSIVE group=1 mask=0x00000018";
        using var conn = device.Connect();
        var ex = Assert.Throws<ExclusiveException>(
            () => conn.ApplySafety(new SafetyConfig(0, false, [0x3, 0x18])));
        Assert.Equal(((byte)1, 0x18U), (ex.Group, ex.Mask));
    }

    [Fact]
    public void AReadBackThatDiffersIsASafetyMismatchListingEveryDifference()
    {
        // A device that drops the wdog setting and the second group.
        var device = new ScriptedDevice(line => line switch
        {
            "excl set 0xc 0x18" or "usbsafe on" or "wdog 800" => ["OK"],
            "safety" => ["OK wdog_ms=0 remaining_ms=0 failsafe=0 cause=none usbsafe=0 excl=1"],
            "excl get" => ["OK count=1", "  mask=0x0000000c"],
            _ => null,
        });
        using var conn = device.Connect();
        var ex = TestHelpers.AssertSdkThrows(
            ErrorCode.SafetyMismatch,
            () => conn.ApplySafety(new SafetyConfig(800, true, [0xc, 0x18])));
        Assert.Contains("wdog_ms is 0, expected 800", ex.Message, StringComparison.Ordinal);
        Assert.Contains("usbsafe is 0, expected 1", ex.Message, StringComparison.Ordinal);
        Assert.Contains("excl is 1, expected 2", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ADifferentMaskIsAMismatch()
    {
        var device = new ScriptedDevice(line => line switch
        {
            "excl set 0xc" or "usbsafe off" or "wdog 0" => ["OK"],
            "safety" => ["OK wdog_ms=0 remaining_ms=0 failsafe=0 cause=none usbsafe=0 excl=1"],
            "excl get" => ["OK count=1", "  mask=0x00000018"],
            _ => null,
        });
        using var conn = device.Connect();
        var ex = TestHelpers.AssertSdkThrows(
            ErrorCode.SafetyMismatch, () => conn.ApplySafety(new SafetyConfig(0, false, [0xc])));
        Assert.Contains(
            "group 0 is 0x00000018, expected 0x0000000c", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void TheLatchAndRemainingTimeAreNotPartOfTheComparison()
    {
        var (device, model) = Safe();
        model.Failsafe = true;
        using var conn = device.Connect();
        var state = conn.ApplySafety(new SafetyConfig(500, false, []));
        Assert.True(state.Failsafe);
        Assert.Equal(FailsafeCause.Wdog, state.Cause);
    }
}

public class HeartbeatTests
{
    private static List<string> Pings(ScriptedDevice device) =>
        device.Commands().Where(c => c.StartsWith("ping ", StringComparison.Ordinal)).ToList();

    private static void WaitFor(Func<bool> condition, string what, int ms = 3000)
    {
        var deadline = Environment.TickCount64 + ms;
        while (!condition())
        {
            Assert.True(Environment.TickCount64 < deadline, $"timed out waiting for {what}");
            Thread.Sleep(2);
        }
    }

    [Theory]
    [InlineData(100U, 25)]
    [InlineData(101U, 25)]
    [InlineData(400U, 100)]
    [InlineData(3999U, 999)]
    [InlineData(4000U, 1000)]
    [InlineData(10000U, 1000)]
    public void ThePeriodIsAQuarterOfTheTimeoutCappedAtOneSecond(uint timeoutMs, int ms) =>
        Assert.Equal(TimeSpan.FromMilliseconds(ms), Heartbeat.PeriodFor(timeoutMs));

    [Theory]
    [InlineData(0U)]
    [InlineData(99U)]
    [InlineData(10001U)]
    public void AnythingBut100To10000IsRefused(uint timeoutMs)
    {
        TestHelpers.AssertSdkThrows(ErrorCode.InvalidArgument, () => Heartbeat.PeriodFor(timeoutMs));
        var device = new ScriptedDevice(_ => null);
        using var conn = device.Connect();
        TestHelpers.AssertSdkThrows(
            ErrorCode.InvalidArgument, () => conn.StartHeartbeat(timeoutMs));
        Assert.Empty(device.Commands());
    }

    [Fact]
    public void PingsStartWithZeroEveryValueDistinctAndNothingElseIsSent()
    {
        var device = new ScriptedDevice(_ => null);
        using var conn = device.Connect();
        using var heartbeat = conn.StartHeartbeat(100);
        Assert.Equal(TimeSpan.FromMilliseconds(25), heartbeat.Period);
        Assert.True(heartbeat.IsRunning);
        WaitFor(() => Pings(device).Count >= 4, "four pings");
        heartbeat.Stop();
        Assert.False(heartbeat.IsRunning);
        var pings = Pings(device);
        Assert.Equal(pings.Select((_, i) => $"ping {i}"), pings);
        Assert.Equal(pings, device.Commands()); // no other command
        Assert.Null(heartbeat.Failure);
    }

    [Fact]
    public void TheFirstPingComesOnePeriodAfterTheStart()
    {
        var device = new ScriptedDevice(_ => null);
        using var conn = device.Connect();
        using var heartbeat = conn.StartHeartbeat(4000); // period 1 s
        Thread.Sleep(150);
        Assert.Empty(Pings(device));
    }

    [Fact]
    public void StoppingSendsNothingMore()
    {
        var device = new ScriptedDevice(_ => null);
        using var conn = device.Connect();
        var heartbeat = conn.StartHeartbeat(100);
        WaitFor(() => Pings(device).Count >= 1, "a ping");
        heartbeat.Stop();
        var after = device.Commands().Count;
        Thread.Sleep(120);
        Assert.Equal(after, device.Commands().Count);
        heartbeat.Stop(); // idempotent
        heartbeat.Dispose();
    }

    [Fact]
    public void AFailedPingIsReportedOnceAndNotRetried()
    {
        var failing = new ScriptedDevice(line => line == "ping 1" ? ["ERR BUSY"] : null);
        using var conn = failing.Connect();
        var raised = new List<SdkException>();
        using var heartbeat = conn.StartHeartbeat(100);
        heartbeat.Failed += e =>
        {
            lock (raised)
            {
                raised.Add(e);
            }
        };
        var failure = heartbeat.WaitFailure(TimeSpan.FromSeconds(3));
        Assert.NotNull(failure);
        Assert.Equal(ErrorCode.Busy, failure!.Code);
        WaitFor(() => !heartbeat.IsRunning, "the heartbeat to end");
        var sent = failing.Commands().Count;
        Thread.Sleep(120);
        Assert.Equal(sent, failing.Commands().Count); // no retry, no further ping
        Assert.Equal(["ping 0", "ping 1"], Pings(failing));
        Assert.Same(failure, heartbeat.Failure);
        Assert.Same(failure, heartbeat.WaitFailure(TimeSpan.FromMilliseconds(10)));
        lock (raised)
        {
            Assert.Single(raised);
        }
    }

    [Fact]
    public void AWrongPongAndATimeoutAreFailures()
    {
        var wrong = new ScriptedDevice(line => line == "ping 0" ? ["OK pong=99"] : null);
        using var conn = wrong.Connect();
        using var heartbeat = conn.StartHeartbeat(100);
        var failure = heartbeat.WaitFailure(TimeSpan.FromSeconds(3));
        Assert.Equal(ErrorCode.Parse, failure?.Code);

        var silent = new ScriptedDevice(line => line.StartsWith("ping ", StringComparison.Ordinal) ? [] : null);
        using var conn2 = silent.Connect(TimeSpan.FromMilliseconds(100));
        using var heartbeat2 = conn2.StartHeartbeat(100);
        Assert.Equal(ErrorCode.Timeout, heartbeat2.WaitFailure(TimeSpan.FromSeconds(3))?.Code);
        WaitFor(() => !heartbeat2.IsRunning, "the heartbeat to end");
    }

    [Fact]
    public void ADeviceThatDisappearsIsAFailure()
    {
        var device = new ScriptedDevice(_ => null);
        using var conn = device.Connect();
        using var heartbeat = conn.StartHeartbeat(100);
        WaitFor(() => Pings(device).Count >= 1, "a ping");
        device.Port.Closed = true; // the cable is pulled
        Assert.Equal(ErrorCode.Disconnected, heartbeat.WaitFailure(TimeSpan.FromSeconds(3))?.Code);
    }

    [Fact]
    public void ClosingTheConnectionEndsTheHeartbeatSilently()
    {
        var device = new ScriptedDevice(_ => null);
        var conn = device.Connect();
        using var heartbeat = conn.StartHeartbeat(100);
        WaitFor(() => Pings(device).Count >= 1, "a ping");
        var before = device.Commands();
        conn.Dispose();
        WaitFor(() => !heartbeat.IsRunning, "the heartbeat to end");
        Assert.Null(heartbeat.WaitFailure(TimeSpan.FromMilliseconds(150)));
        Assert.Null(heartbeat.Failure);
        // Closing sent no command of its own.
        Assert.All(device.Commands().Skip(before.Count), c =>
            Assert.StartsWith("ping ", c, StringComparison.Ordinal));
    }

    [Fact]
    public void CommandsOfTheCallerAreNeverInterleavedWithPings()
    {
        var model = new ScriptedDevice.SafetyModel { Groups = [0x3, 0xc] };
        var device = new ScriptedDevice(line => model.Handle(line));
        using var conn = device.Connect();
        using var heartbeat = conn.StartHeartbeat(100);
        for (var i = 0; i < 60; i++)
        {
            // A counted response and a single-line one, with pings due all the time.
            Assert.Equal([0x3U, 0xcU], conn.ExclGet());
            Assert.Equal(2, conn.Safety().Excl);
            Thread.Sleep(1);
        }

        Assert.Null(heartbeat.Failure);
        Assert.True(Pings(device).Count > 0, "the heartbeat never pinged");
    }
}
