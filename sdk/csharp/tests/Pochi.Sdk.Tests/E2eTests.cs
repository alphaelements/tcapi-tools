using Xunit;

namespace Pochi.Sdk.Tests;

// End-to-end tests against a mock firmware (same scenarios as the Rust PTY
// E2E in sdk/rust/tests/pty_e2e.rs, over an in-memory port).

public class E2eTests
{
    private static (Connection Conn, FakePort Port) ConnectMock(
        MockFw fw, string[]? prePush = null)
    {
        var port = new FakePort();
        var pushes = prePush ?? [];
        port.OnCommand = cmd => port.Feed([.. pushes, .. fw.Handle(cmd)]);
        return (Connection.FromPort(port), port);
    }

    [Fact]
    public void FullCommandSweep()
    {
        var (conn, _) = ConnectMock(new MockFw());

        var v = conn.Version();
        Assert.Equal(((byte)0, (byte)1, (byte)0, (byte)1),
            (v.Major, v.Minor, v.Patch, v.ProtocolVersion));
        var caps = conn.Caps();
        Assert.Equal(23, caps.MaxDio);
        Assert.Equal(40U, caps.TsResolutionNs);
        Assert.Equal(1, caps.ProtocolVersion);
        Assert.True(caps.HasSync);
        var info = conn.Info();
        Assert.Equal("AABBCCDD11223344", info.Uid);
        Assert.Equal((byte?)42, info.DeviceNumber);
        conn.SetDeviceNumber(7);

        Assert.Equal(0x05U, conn.Read());
        conn.Write(0x0A, 0x0F);
        Assert.Equal(0x0AU, conn.State().Outputs);

        var pinMap = conn.MapGet();
        Assert.Equal(12, pinMap.OutCount);
        Assert.Equal(PullMode.Up, pinMap.Pull);
        conn.MapSet(new PinMap(
            Version: 1, OutBase: 0, OutCount: 8, InBase: 8, InCount: 15,
            Pull: PullMode.Up, Flags: 1));
        Assert.Equal(8, conn.MapGet().OutCount);
        conn.MapSave();
        conn.MapDefault();
        Assert.Equal(23, conn.MapGet().InCount);

        var accepted = conn.PatternLoad(
        [
            new PatternStep(OutBits: 0x0F, HoldUs: 100),
            new PatternStep(OutBits: 0, HoldUs: 100),
        ]);
        Assert.Equal(2, accepted);
        conn.PatternRun(PatternMode.Loop, 10);
        Assert.Equal(PatternState.Running, conn.PatternStatus().State);
        conn.PatternStop();
        Assert.Equal(PatternState.Loaded, conn.PatternStatus().State);

        conn.TsArm(0x07FF, EdgeMode.Both);
        var result = conn.TsGet(256);
        Assert.Equal(2, result.Events.Count);
        Assert.Equal(1_000_280, result.Events[0].TimestampNs);
        Assert.False(result.Reconciled);
        Assert.False(result.Overflow);
        conn.TsDisarm();

        conn.SyncMaster();
        conn.SyncStart();
        Assert.Equal(1_000_000UL, conn.SyncCount());
        conn.SyncStop();
        conn.SyncDisarm();

        Assert.Equal("OK v0.1.0 proto=1", conn.Raw("version"));
        conn.Close();
    }

    [Fact]
    public void TypedDeviceErrors()
    {
        var (conn, _) = ConnectMock(new MockFw());
        TestHelpers.AssertSdkThrows(ErrorCode.NotArmed, () => conn.TsGet(10));
        TestHelpers.AssertSdkThrows(ErrorCode.SyncState, () => conn.SyncCount());
        TestHelpers.AssertSdkThrows(ErrorCode.BadParam,
            () => conn.PatternRun(PatternMode.Once, 1));
        Assert.Equal("ERR UNKNOWN_CMD", conn.Raw("frobnicate"));
        // pattern stop while idle surfaces ErrNotRunning (FW v0.1.3+)
        TestHelpers.AssertSdkThrows(ErrorCode.NotRunning, () => conn.PatternStop());
    }

    [Fact]
    public void LoopRepeatZeroRejected()
    {
        var (conn, _) = ConnectMock(new MockFw());
        conn.PatternLoad([new PatternStep(OutBits: 1, HoldUs: 1)]);
        TestHelpers.AssertSdkThrows(ErrorCode.BadParam,
            () => conn.PatternRun(PatternMode.Loop, 0));
    }

    [Fact]
    public void PatternResetReturnsEngineToIdle()
    {
        var (conn, _) = ConnectMock(new MockFw());
        conn.PatternLoad([new PatternStep(OutBits: 1, HoldUs: 1)]);
        conn.PatternRun(PatternMode.Loop, 10);
        Assert.Equal(PatternState.Running, conn.PatternStatus().State);
        conn.PatternReset();
        Assert.Equal(PatternState.Idle, conn.PatternStatus().State);
        TestHelpers.AssertSdkThrows(ErrorCode.BadParam,
            () => conn.PatternRun(PatternMode.Once, 1));
    }

    [Fact]
    public void SystemResetAndBootselResetSucceed()
    {
        var (conn, _) = ConnectMock(new MockFw());
        conn.SystemReset();
        // Mock keeps the port open; real device re-enumerates here.
        conn.BootselReset();
    }

    private sealed class CollectingObserver : IObserver<PushEvent>
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
    }

    [Fact]
    public void PushEventsInterleavedWithCommands()
    {
        var (conn, _) = ConnectMock(new MockFw(),
            ["! INPUT 0x000001 t=100", "! PATTERN_DONE loops=2"]);
        var observer = new CollectingObserver();
        using var subscription = conn.Events.Subscribe(observer);
        conn.Subscribe(true);
        Assert.Equal(0x05U, conn.Read());

        var deadline = Environment.TickCount64 + 1000;
        while (observer.Snapshot().Count < 4 && Environment.TickCount64 < deadline)
        {
            Thread.Sleep(10);
        }

        var events = observer.Snapshot();
        Assert.Equal(2, events.Count(e =>
            e == new InputChangeEvent(Inputs: 1, TimestampUs: 100)));
        Assert.Equal(2, events.Count(e => e == new PatternDoneEvent(Loops: 2)));
    }

    [Fact]
    public void OldFirmwareFailsLoudly()
    {
        var fw = new MockFw { OldFirmware = true };
        var (conn, _) = ConnectMock(fw);
        TestHelpers.AssertSdkThrows(ErrorCode.UnsupportedFirmware, () => conn.Caps());
        conn.TsArm(0x01, EdgeMode.Rising);
        TestHelpers.AssertSdkThrows(ErrorCode.UnsupportedFirmware, () => conn.TsGet(10));
    }

    [Fact]
    public void EmptyTsRingKeepsConnectionHealthy()
    {
        var fw = new MockFw { TsEvents = [] };
        var (conn, _) = ConnectMock(fw);
        conn.TsArm(0x01, EdgeMode.Rising);
        var result = conn.TsGet(256);
        Assert.Empty(result.Events);
        Assert.False(result.Overflow);
        Assert.Equal(0x05U, conn.Read());
    }

    [Fact]
    public void TsOverflowFlagPropagates()
    {
        var fw = new MockFw { TsOverflow = true };
        var (conn, _) = ConnectMock(fw);
        conn.TsArm(0x0F, EdgeMode.Rising);
        var result = conn.TsGet(256);
        Assert.True(result.Overflow);
        Assert.Equal(2, result.Events.Count);
    }

    [Fact]
    public void ReconcilePipelineFromTsGet()
    {
        var fw = new MockFw
        {
            // Straddle pair: naive ns values 1000ns apart, reconcile -> zero diff.
            TsEvents = ["  0x00000001 c=1001 p=2 s=1", "  0x00000003 c=1000 p=2 s=1"],
        };
        var (conn, _) = ConnectMock(fw);
        conn.TsArm(0x03, EdgeMode.Rising);
        var result = conn.TsGet(256);

        var groups = Reconciler.GroupEvents(result.Events
            .Select((ev, i) => new SourceEvent(
                Device: "local",
                Channel: $"GP{i}",
                Inputs: $"0x{ev.Inputs:X8}",
                RawCount: ev.RawCount,
                RawPhase: ev.RawPhase,
                SyncActive: ev.SyncActive))
            .ToList());
        Assert.Single(groups);
        Assert.True(groups[0].Reconciled);
        Assert.Equal(groups[0].ReconciledNs[0], groups[0].ReconciledNs[1]);
    }
}
