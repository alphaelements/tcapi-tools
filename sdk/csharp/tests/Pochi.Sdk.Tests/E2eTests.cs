using Xunit;

namespace Pochi.Sdk.Tests;

// Typed-API scenarios against fake firmware generated from the golden
// transcripts (GoldenFw): the device answers exactly what the transcript
// records, and every request the SDK sends must match the transcript's request.
// The full corpus is replayed in GoldenReplayTests; these are the readable
// scenarios.

public class E2eTests
{
    private static GoldenFw Fw(string file, string titlePart) =>
        new(GoldenCorpus.Case(file, titlePart));

    private static void AssertScriptFollowed(GoldenFw fw) => Assert.Empty(fw.Mismatches);

    /// <summary>The pin map "B" the golden io transcripts use: GP0-GP3
    /// outputs (default level 0x5), GP4 and up inputs.</summary>
    private static readonly PinMap MapB = new(
        Flags: 0, Direction: 0x0F, PullUp: 0, PullDown: 0x0C7F_FFF0, OutDefault: 0x05,
        OutPolarity: 0, InPolarity: 0, Edge: 0x0C7F_FFF0);

    private sealed class Collector : IObserver<PushEvent>
    {
        private readonly List<PushEvent> _events = [];

        public List<PushEvent> Snapshot()
        {
            lock (_events)
            {
                return [.. _events];
            }
        }

        public void OnNext(PushEvent value)
        {
            lock (_events)
            {
                _events.Add(value);
            }
        }

        public void OnCompleted()
        {
        }

        public void OnError(Exception error)
        {
        }

        public void WaitForCount(int count)
        {
            var deadline = Environment.TickCount64 + 2000;
            while (Snapshot().Count < count && Environment.TickCount64 < deadline)
            {
                Thread.Sleep(5);
            }

            Assert.True(Snapshot().Count >= count, $"expected {count} events");
        }
    }

    // --- opening: DTR is asserted by the serial adapter, proto=2 is required ---

    [Fact]
    public void OpenRequiresProto2AndExposesTheFirmwareVersion()
    {
        var fw = Fw("version-info", "version");
        using var conn = fw.Connect();
        Assert.Equal(new VersionInfo(0, 1, 3, 2), conn.Firmware);
        Assert.Empty(fw.Port.Written.Skip(1)); // `version` is the only line sent on open
        Assert.Equal("version", fw.Port.Written[0]);
    }

    [Theory]
    [InlineData("OK fw=0.1.3 proto=3")]
    [InlineData("OK fw=0.1.3 proto=0")]
    [InlineData("OK v0.1.0 proto=7")] // legacy line shape on another protocol
    [Trait("Category", "Negative")]
    public void ForeignProtocolFailsTheOpenAndClosesThePort(string version)
    {
        var port = new FakePort { OnCommand = _ => { } };
        port.OnCommand = _ => port.Feed(version);
        var ex = TestHelpers.AssertSdkThrows(
            ErrorCode.UnsupportedFirmware, () => Connection.FromPort(port));
        Assert.Contains("unsupported protocol", ex.Message);
        Assert.True(port.Closed);
        Assert.Equal(["version"], port.Written);
    }

    [Fact]
    [Trait("Category", "Negative")]
    public void UnreadableVersionFailsTheOpenWithAParseError()
    {
        var port = new FakePort();
        port.OnCommand = _ => port.Feed("OK nonsense");
        TestHelpers.AssertSdkThrows(ErrorCode.Parse, () => Connection.FromPort(port));
        Assert.True(port.Closed);
    }

    // --- device information ---

    [Fact]
    public void CapsFollowTheDirectionMask()
    {
        var fw = Fw("version-info", "caps follows the direction mask");
        using var conn = fw.Connect();
        conn.MapSet(PinMap.Default with
        {
            Direction = 0x3,
            PullDown = 0x0C7F_FFFC,
            Edge = 0x0C7F_FFFC,
        });
        var caps = conn.Caps();
        // The feature mask is the one of the transcript's firmware revision: pin
        // neither its value nor its history, only the defined bits (0..=7).
        Assert.Equal(25, caps.Dio);
        Assert.Equal(2, caps.Out);
        Assert.Equal(23, caps.In);
        Assert.Equal(0u, caps.Features & ~0xFFu);
        Assert.True(caps.HasSync && caps.HasReset);
        AssertScriptFollowed(fw);
    }

    [Fact]
    public void DeviceNumberCanBeAssignedAndCleared()
    {
        var fw = Fw("version-info", "devnum: assign, read back, clear");
        using var conn = fw.Connect();
        conn.SetDeviceNumber(7);
        var info = conn.Info();
        Assert.Equal((byte?)7, info.DeviceNumber);
        Assert.Equal("0000000000000000", info.Uid);
        Assert.Equal("0.1.3", info.Version);
        conn.SetDeviceNumber(255);
        Assert.Null(conn.Info().DeviceNumber);
        AssertScriptFollowed(fw);
    }

    [Fact]
    public void PingEchoesTheValue()
    {
        var fw = Fw("version-info", "ping: u32 limits");
        using var conn = fw.Connect();
        Assert.Equal(uint.MaxValue, conn.Ping(uint.MaxValue));
        Assert.Equal(uint.MaxValue, conn.Ping(0xFFFFFFFF));
        AssertScriptFollowed(fw);
    }

    // --- digital I/O and the pin map ---

    [Fact]
    public void WriteChangesOnlyTheMaskedPins()
    {
        var fw = Fw("io", "write: only the masked pins change");
        using var conn = fw.Connect();
        conn.MapSet(MapB);
        conn.Write(0x2, 0x3);
        Assert.Equal(new IoState(0, 0x06), conn.State());
        AssertScriptFollowed(fw);
    }

    [Fact]
    public void WriteOnANonOutputIsRefusedByTheDevice()
    {
        var fw = Fw("io", "write: mask covers a pin that is not an output");
        using var conn = fw.Connect();
        conn.MapSet(MapB);
        TestHelpers.AssertSdkThrows(ErrorCode.BadParam, () => conn.Write(0x10, 0x10));
        TestHelpers.AssertSdkThrows(ErrorCode.BadParam, () => conn.Write(0xF, 0x1F));
        Assert.Equal(new IoState(0, 0x05), conn.State()); // nothing changed
        AssertScriptFollowed(fw);
    }

    [Fact]
    public void WriteOutsideTheDioPinsIsRefusedBeforeSending()
    {
        var fw = Fw("io", "write: mask with bits outside the DIO pins");
        using var conn = fw.Connect();
        var sent = fw.Port.Written.Count;
        TestHelpers.AssertSdkThrows(
            ErrorCode.InvalidArgument, () => conn.Write(0xFFFFFFFF, 0xFFFFFFFF));
        Assert.Equal(sent, fw.Port.Written.Count);
    }

    [Fact]
    public void ReadFollowsTheDrivenInputsAndPolarity()
    {
        var fw = Fw("io", "read: ipol inverts the input pins");
        using var conn = fw.Connect();
        conn.MapSet(new PinMap(0, 0x0F, 0xF0, 0x0C7F_FF00, 0x05, 0x08, 0x100, 0x0C7F_FFF0));
        Assert.Equal(0x1F0U, conn.Read());
        Assert.Equal(0x100U, conn.Read());
        AssertScriptFollowed(fw);
    }

    [Fact]
    public void ReadWithoutInputPinsIsNoResource()
    {
        var fw = Fw("io", "read: no input pins configured");
        using var conn = fw.Connect();
        conn.MapSet(PinMap.Default with { Direction = Pins.ValidDioMask, PullDown = 0, Edge = 0 });
        TestHelpers.AssertSdkThrows(ErrorCode.NoResource, () => conn.Read());
        AssertScriptFollowed(fw);
    }

    [Fact]
    public void MapRoundTripsAndAnInvalidMapIsNeverSent()
    {
        var fw = Fw("map", "map set: full map, then get echoes it");
        using var conn = fw.Connect();
        conn.MapSet(PinMapTests.DocMap);
        Assert.Equal(PinMapTests.DocMap, conn.MapGet());
        AssertScriptFollowed(fw);

        var sent = fw.Port.Written.Count;
        TestHelpers.AssertSdkThrows(
            ErrorCode.InvalidArgument, () => conn.MapSet(PinMapTests.DocMap with { Flags = 1 }));
        Assert.Equal(sent, fw.Port.Written.Count);
    }

    // --- pattern ---

    [Fact]
    public void PatternAddAccumulatesTheTotal()
    {
        var fw = Fw("pattern", "pattern add: totals accumulate over calls");
        using var conn = fw.Connect();
        conn.MapSet(PinMap.Default with
        {
            Direction = 0x3,
            PullDown = 0x0C7F_FFFC,
            Edge = 0x0C7F_FFFC,
        });
        Assert.Equal(2, conn.PatternAdd([new(1, 5), new(0, 10)]));
        Assert.Equal(3, conn.PatternAdd([new(2, 1)]));
        Assert.Equal(6, conn.PatternAdd([new(3, 7), new(0, 7), new(1, 7)]));
        Assert.Equal(new PatternStatus(PatternState.Loaded, 0, 0, 6), conn.PatternStatus());
        AssertScriptFollowed(fw);
    }

    [Fact]
    public void PatternLoadResetsThenAddsInLinesOfAtMost256Bytes()
    {
        // The golden transcript sends 256 one-tick steps as six lines of 40
        // steps and one of 16; PatternLoad must pack exactly the same way.
        var boundary = GoldenCorpus.Case("boundary", "256 pattern steps are accepted");
        var adds = boundary.Steps
            .Where(s => s.Kind == GoldenStepKind.Request
                && s.Text.StartsWith("pattern add", StringComparison.Ordinal))
            .Take(7)
            .ToList();
        Assert.Equal(7, adds.Count);
        var reset = new GoldenStep(
            GoldenStepKind.Request, "pattern reset", GoldenCorpus.FirstResponse("pattern reset"), 0);
        var fw = new GoldenFw(new GoldenCase("boundary", "load", 0, [reset, .. adds])) { Exact = true };
        using var conn = fw.Connect();

        var steps = Enumerable.Range(0, 256).Select(_ => new PatternStep(0, 1)).ToList();
        Assert.Equal(256, conn.PatternLoad(steps));
        AssertScriptFollowed(fw);
        Assert.True(fw.Finished);
        Assert.All(fw.Port.Written, l => Assert.True(l.Length <= 256));
    }

    [Fact]
    public void PatternAddRefusesWhatDoesNotFitOneLine()
    {
        var fw = Fw("version-info", "version");
        using var conn = fw.Connect();
        var steps = Enumerable.Range(0, 41).Select(_ => new PatternStep(0, 1)).ToList();
        TestHelpers.AssertSdkThrows(ErrorCode.InvalidArgument, () => conn.PatternAdd(steps));
        Assert.Single(fw.Port.Written); // only the open handshake
    }

    [Fact]
    public void PatternStopWhenNotRunningIsNotRunning()
    {
        var fw = Fw("errors", "ERR NOT_RUNNING");
        using var conn = fw.Connect();
        TestHelpers.AssertSdkThrows(ErrorCode.NotRunning, () => conn.PatternStop());
        AssertScriptFollowed(fw);
    }

    [Fact]
    public void LoopRepeatOfZeroIsRefusedBeforeSending()
    {
        var fw = Fw("version-info", "version");
        using var conn = fw.Connect();
        TestHelpers.AssertSdkThrows(
            ErrorCode.InvalidArgument, () => conn.PatternRun(PatternMode.Loop, 0));
        Assert.Single(fw.Port.Written);
    }

    // --- timestamps ---

    [Fact]
    public void TimestampsUnderSyncCarryRawCountsAndPhases()
    {
        var fw = Fw("timestamp", "ts under sync");
        using var conn = fw.Connect();
        conn.SyncMaster();
        conn.SyncStart();
        conn.TsArm(0x1, EdgeMode.Both);
        conn.SyncStop();
        var result = conn.TsGet(10);

        Assert.False(result.Overflow);
        Assert.Equal(
            [
                new TimestampEvent(1, 2, 12, true),
                new TimestampEvent(0, 3, 24, true),
                new TimestampEvent(1, 4, 0, true),
                new TimestampEvent(0, 107, 0, false),
            ],
            result.Events);

        // The caller supplies the resolution from caps; there is no constant.
        Assert.Equal([2480L, 3960L, 4000L, 107_000L], result.Events.Select(e => e.Ns(40)));
        AssertScriptFollowed(fw);
    }

    [Fact]
    public void TsGetReportsTheOverflowFlagOnce()
    {
        var fw = Fw("timestamp", "ts ring overflow");
        using var conn = fw.Connect();
        conn.TsArm(0x1, EdgeMode.Both);
        Assert.Equal(new TsStatus(true, 256, true), conn.TsStatus());
        var first = conn.TsGet(5);
        Assert.True(first.Overflow);
        Assert.Equal(new uint[] { 20, 30, 40, 50, 60 }, first.Events.Select(e => e.RawCount));
        // The overflow flag is reported once and then cleared.
        Assert.Equal(new TsStatus(true, 251, false), conn.TsStatus());
        var second = conn.TsGet(2);
        Assert.False(second.Overflow);
        Assert.Equal(new uint[] { 70, 80 }, second.Events.Select(e => e.RawCount));
        AssertScriptFollowed(fw);
    }

    [Fact]
    public void TsGetWithoutArmIsNotArmed()
    {
        var fw = Fw("timestamp", "ts get: not armed");
        using var conn = fw.Connect();
        TestHelpers.AssertSdkThrows(ErrorCode.NotArmed, () => conn.TsGet(1));
        AssertScriptFollowed(fw);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(86)]
    public void TsGetOutsideOneTo85IsRefusedBeforeSending(ushort max)
    {
        var fw = Fw("timestamp", "ts get: max outside 1-85 is refused");
        using var conn = fw.Connect();
        TestHelpers.AssertSdkThrows(ErrorCode.InvalidArgument, () => conn.TsGet(max));
        Assert.Single(fw.Port.Written);
    }

    [Fact]
    public void ReconcilePipelineFromTsGetUsesTheResolutionFromCaps()
    {
        // Two events of one physical instant, a count apart (straddle):
        // naive values differ by 1000 ns, reconcile makes them agree.
        var events = new[]
        {
            new TimestampEvent(0x1, 1001, 2, true),
            new TimestampEvent(0x3, 1000, 2, true),
        };
        var caps = new Capabilities(25, 0, 25, TsResNs: 40, 200, 256, 256, 3);
        var groups = Reconciler.GroupEvents(
            events.Select((ev, i) => new SourceEvent(
                "local", Pins.PinLabel((byte)i), ev.Inputs, ev.RawCount, ev.RawPhase,
                ev.SyncActive)).ToList(),
            caps.TsResNs);
        Assert.Single(groups);
        Assert.True(groups[0].Reconciled);
        Assert.Equal(groups[0].ReconciledNs[0], groups[0].ReconciledNs[1]);
    }

    // --- sync ---

    [Fact]
    public void SyncCountIsASingleLineAndFollowsTheClock()
    {
        var fw = Fw("sync", "sync master -> start -> count -> stop");
        using var conn = fw.Connect();
        conn.SyncMaster();
        conn.SyncStart();
        Assert.Equal(0UL, conn.SyncCount());
        Assert.Equal(1000UL, conn.SyncCount());
        Assert.Equal(1000UL, conn.SyncCount());
        Assert.Equal(1001UL, conn.SyncCount());
        conn.SyncStop();
        TestHelpers.AssertSdkThrows(ErrorCode.SyncState, () => conn.SyncCount());
        AssertScriptFollowed(fw);
    }

    [Fact]
    public void SyncArmTwiceIsASyncStateError()
    {
        var fw = Fw("sync", "sync arm: slave-armed state");
        using var conn = fw.Connect();
        conn.SyncArm();
        TestHelpers.AssertSdkThrows(ErrorCode.SyncState, () => conn.SyncArm());
        TestHelpers.AssertSdkThrows(ErrorCode.SyncState, () => conn.SyncMaster());
        TestHelpers.AssertSdkThrows(ErrorCode.SyncState, () => conn.SyncStart());
        TestHelpers.AssertSdkThrows(ErrorCode.SyncState, () => conn.SyncStop());
        TestHelpers.AssertSdkThrows(ErrorCode.SyncState, () => conn.SyncCount());
        AssertScriptFollowed(fw);
    }

    // --- reset ---

    [Fact]
    public void ResetAndBootselAcknowledge()
    {
        var reset = Fw("reset", "reset: acknowledges");
        using (var conn = reset.Connect())
        {
            conn.Reset();
            AssertScriptFollowed(reset);
        }

        var bootsel = Fw("reset", "bootsel: acknowledges");
        using (var conn = bootsel.Connect())
        {
            conn.Bootsel();
            AssertScriptFollowed(bootsel);
        }
    }

    // --- raw ---

    [Fact]
    public void RawReturnsEveryLineOfACountedResponse()
    {
        var fw = Fw("reset", "help: counted response");
        using var conn = fw.Connect();
        var lines = conn.Raw("help");
        Assert.StartsWith("OK count=", lines[0], StringComparison.Ordinal);
        Assert.Equal(1 + int.Parse(lines[0]["OK count=".Length..], System.Globalization.CultureInfo.InvariantCulture), lines.Count);
        Assert.StartsWith("  version", lines[1], StringComparison.Ordinal);
        AssertScriptFollowed(fw);
    }

    [Theory]
    [InlineData("subscribe on")]
    [InlineData("SUBSCRIBE off")]
    [InlineData("  Subscribe\ton")]
    [InlineData("subscribe")]
    public void RawRejectsSubscribeBecauseTheSdkOwnsIt(string command)
    {
        var fw = Fw("version-info", "version");
        using var conn = fw.Connect();
        TestHelpers.AssertSdkThrows(ErrorCode.InvalidArgument, () => conn.Raw(command));
        Assert.Single(fw.Port.Written);
    }

    [Fact]
    public void RawRefusesAnOverlongLine()
    {
        var fw = Fw("version-info", "version");
        using var conn = fw.Connect();
        TestHelpers.AssertSdkThrows(
            ErrorCode.InvalidArgument, () => conn.Raw("pattern add " + new string('x', 250)));
        Assert.Single(fw.Port.Written);
    }

    [Fact]
    public void RawFollowsTheSameResyncRulesAsOtherCommands()
    {
        var fw = Fw("errors", "an error leaves the device usable");
        using var conn = fw.Connect();
        Assert.Equal(["ERR UNKNOWN_CMD"], conn.Raw("nonsense"));
        Assert.Equal(["OK pong=1"], conn.Raw("ping 1"));
        AssertScriptFollowed(fw);
    }

    // --- events and the subscription refcount (R-H4) ---

    [Fact]
    public void FirstSubscriberTurnsTheDeviceSubscriptionOnAndTheLastTurnsItOff()
    {
        var fw = Fw("timestamp", "subscribe on and off");
        using var conn = fw.Connect();
        var a = new Collector();
        var b = new Collector();

        var subA = conn.Events.Subscribe(a);
        Assert.Equal(["version", "subscribe on"], fw.Port.Written);
        var subB = conn.Events.Subscribe(b);
        Assert.Equal(2, fw.Port.Written.Count); // the second subscriber shares the subscription

        subA.Dispose();
        Assert.Equal(2, fw.Port.Written.Count); // one subscriber is left
        subB.Dispose();
        Assert.Equal(["version", "subscribe on", "subscribe off"], fw.Port.Written);
        subB.Dispose(); // disposing twice does nothing
        Assert.Equal(3, fw.Port.Written.Count);
        AssertScriptFollowed(fw);
        Assert.True(fw.Finished);
    }

    [Fact]
    public void SubscribingAgainAfterTheLastLeftTurnsTheDeviceSubscriptionOnAgain()
    {
        var port = new FakePort();
        port.OnCommand = line =>
        {
            if (line == "version")
            {
                port.Feed(GoldenCorpus.FirstResponse("version").ToArray());
            }
            else
            {
                port.Feed(GoldenCorpus.FirstResponse(line).ToArray());
            }
        };
        using var conn = Connection.FromPort(port);
        for (var i = 0; i < 3; i++)
        {
            conn.Events.Subscribe(new Collector()).Dispose();
        }

        Assert.Equal(
            ["version", "subscribe on", "subscribe off", "subscribe on", "subscribe off",
                "subscribe on", "subscribe off"],
            port.Written);
    }

    [Fact]
    public void EventsReachEverySubscriberOnce()
    {
        var fw = Fw("events", "PATTERN_DONE: with subscribe on it is still a single event");
        using var conn = fw.Connect();
        var a = new Collector();
        var b = new Collector();
        conn.MapSet(PinMap.Default with
        {
            Direction = 0x3,
            PullDown = 0x0C7F_FFFC,
            Edge = 0x0C7F_FFFC,
        });
        // Not disposed: the transcript ends without `subscribe off`.
        conn.Events.Subscribe(a);
        conn.Events.Subscribe(b);
        conn.PatternAdd([new(1, 5), new(0, 10)]);
        conn.PatternRun(PatternMode.Once, 1);
        fw.PumpEvents();
        a.WaitForCount(1);
        b.WaitForCount(1);
        Assert.Equal([new PatternDoneEvent(1)], a.Snapshot());
        Assert.Equal([new PatternDoneEvent(1)], b.Snapshot());
        AssertScriptFollowed(fw);
    }

    [Fact]
    public void InputEventsStopAfterTheLastSubscriberLeaves()
    {
        var fw = Fw("events", "INPUT: events are not sent before subscribe on");
        using var conn = fw.Connect();
        var events = new Collector();
        var subscription = conn.Events.Subscribe(events);
        fw.PumpEvents(); // the transcript has an event after `subscribe on`
        events.WaitForCount(1);
        Assert.Equal([new InputChangeEvent(0, 2)], events.Snapshot());
        subscription.Dispose();
        AssertScriptFollowed(fw);
        Assert.True(fw.Finished);
    }

    [Fact]
    public void RefusedSubscribeThrowsTheDeviceErrorAndAttachesNothing()
    {
        var fw = Fw("timestamp", "subscribe on: no input pins configured");
        using var conn = fw.Connect();
        conn.MapSet(PinMap.Default with { Direction = Pins.ValidDioMask, PullDown = 0, Edge = 0 });
        var events = new Collector();
        TestHelpers.AssertSdkThrows(ErrorCode.NoResource, () => conn.Events.Subscribe(events));
        AssertScriptFollowed(fw);
    }

    [Fact]
    public void EventsCompleteWhenTheConnectionCloses()
    {
        var fw = Fw("timestamp", "subscribe on and off");
        var conn = fw.Connect();
        var completed = new ManualResetEventSlim();
        conn.Events.Subscribe(new CompletionObserver(completed));
        conn.Close();
        Assert.True(completed.IsSet);
        // Subscribing after close completes immediately.
        var late = new ManualResetEventSlim();
        conn.Events.Subscribe(new CompletionObserver(late));
        Assert.True(late.IsSet);
    }

    private sealed class CompletionObserver(ManualResetEventSlim done) : IObserver<PushEvent>
    {
        public void OnNext(PushEvent value)
        {
        }

        public void OnCompleted() => done.Set();

        public void OnError(Exception error)
        {
        }
    }

    // --- parse failures resynchronise ---

    [Fact]
    [Trait("Category", "Negative")]
    public void ACorruptResponseIsAParseErrorAndTheNextCommandResynchronises()
    {
        var fw = Fw("version-info", "version");
        using var conn = fw.Connect();
        fw.Port.OnCommand = line =>
        {
            if (line.StartsWith("ping ", StringComparison.Ordinal))
            {
                fw.Port.Feed("OK pong=" + line["ping ".Length..]);
            }
            else if (line == "caps")
            {
                fw.Port.Feed("OK dio=25 out=oops");
            }
            else
            {
                fw.Port.Feed(GoldenCorpus.FirstResponse(line).ToArray());
            }
        };
        TestHelpers.AssertSdkThrows(ErrorCode.Parse, () => conn.Caps());
        Assert.Equal(new VersionInfo(0, 1, 3, 2), conn.Version());
        Assert.StartsWith("ping ", fw.Port.Written[^2], StringComparison.Ordinal);
    }

    [Fact]
    [Trait("Category", "Negative")]
    public void ABareOkCommandThatAnswersWithDataIsAParseError()
    {
        var fw = Fw("version-info", "version");
        using var conn = fw.Connect();
        fw.Port.OnCommand = line =>
        {
            fw.Port.Feed(line.StartsWith("ping ", StringComparison.Ordinal)
                ? "OK pong=" + line["ping ".Length..]
                : "OK extra=1");
        };
        TestHelpers.AssertSdkThrows(ErrorCode.Parse, () => conn.MapSave());
    }
}
