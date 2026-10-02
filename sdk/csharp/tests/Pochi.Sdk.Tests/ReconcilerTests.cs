using Xunit;

namespace Pochi.Sdk.Tests;

// Reconcile test vectors ported verbatim from the Rust reference
// (sdk/rust/src/reconcile.rs); all SDKs must produce identical results. The
// phase resolution is an argument (Capabilities.TsResNs), never a constant.

public class CandidatesTests
{
    private const uint Res = 40;

    [Fact]
    public void Basic() =>
        Assert.Equal(new long[] { 1000280, 999280, 1001280 },
            Reconciler.Candidates(1000, 7, Res));

    [Fact]
    public void CountZero() =>
        Assert.Equal(new long[] { 280, -720, 1280 }, Reconciler.Candidates(0, 7, Res));

    [Fact]
    public void PhaseBounds()
    {
        Assert.Equal(new long[] { 1000000, 999000, 1001000 },
            Reconciler.Candidates(1000, 0, Res));
        Assert.Equal(new long[] { 1000960, 999960, 1001960 },
            Reconciler.Candidates(1000, 24, Res));
    }

    [Fact]
    public void ResolutionIsAnArgument()
    {
        Assert.Equal(new long[] { 1000350, 999350, 1001350 },
            Reconciler.Candidates(1000, 7, 50));
        Assert.Equal(1_000_350, Reconciler.AsIsNs(1000, 7, 50));
    }

    [Fact]
    public void AsIsNsMatchesTheEventHelper()
    {
        var ev = new TimestampEvent(1, 1000, 7, true);
        Assert.Equal(Reconciler.AsIsNs(1000, 7, Res), ev.Ns(Res));
    }

    [Fact]
    public void EventNsGatesPhaseOnSyncActive()
    {
        Assert.Equal(1_000_280, Reconciler.EventNs(1000, 7, true, Res));
        Assert.Equal(1_000_000, Reconciler.EventNs(1000, 7, false, Res));
        var free = new TimestampEvent(1, 1000, 7, false);
        Assert.Equal(Reconciler.EventNs(1000, 7, false, Res), free.Ns(Res));
    }
}

public class ReconcileTests
{
    private const uint Res = 40;

    [Fact]
    public void K0IsEmpty() => Assert.Empty(Reconciler.Reconcile([], Res));

    [Fact]
    public void K1AsIs() =>
        Assert.Equal([1000280L], Reconciler.Reconcile([(1000, 7)], Res));

    [Fact]
    public void K2NoCrossing() =>
        Assert.Equal([1000280L, 1000360L], Reconciler.Reconcile([(1000, 7), (1000, 9)], Res));

    [Fact]
    public void K2CountMinus1() =>
        Assert.Equal([1000080L, 1000080L], Reconciler.Reconcile([(1001, 2), (1000, 2)], Res));

    [Fact]
    public void K2CountPlus1() =>
        Assert.Equal([1000920L, 1000920L], Reconciler.Reconcile([(999, 23), (1000, 23)], Res));

    [Fact]
    public void K2BothShifted()
    {
        var r = Reconciler.Reconcile([(1001, 1), (999, 24)], Res);
        Assert.Equal([1000040L, 999960L], r);
        Assert.True(Math.Abs(r[0] - r[1]) <= 100);
    }

    [Fact]
    public void K3() =>
        Assert.Equal([1000040L, 1000040L, 1000080L],
            Reconciler.Reconcile([(1000, 1), (1001, 1), (1000, 2)], Res));

    [Fact]
    public void K4()
    {
        Assert.Equal([1000920L, 1001040L, 1000960L, 1000880L],
            Reconciler.Reconcile([(1000, 23), (1001, 1), (1000, 24), (1000, 22)], Res));
        Assert.Equal([999960L, 999960L, 999920L, 999880L],
            Reconciler.Reconcile([(999, 24), (1000, 24), (999, 23), (999, 22)], Res));
    }

    [Fact]
    public void TiePrefersAsIs() =>
        Assert.Equal([1000280L, 1000280L], Reconciler.Reconcile([(1000, 7), (1000, 7)], Res));

    [Fact]
    public void KTooLargeAsIs() =>
        Assert.Equal(Enumerable.Repeat(1000280L, 9).ToList(),
            Reconciler.Reconcile(Enumerable.Repeat(((uint)1000, (byte)7), 9).ToList(), Res));

    [Fact]
    public void K8StillSearchesExhaustively()
    {
        // Eight events of one instant, one of them a count ahead: the search
        // finds a combination in which all eight agree (score 0). Two such
        // combinations exist; the tie goes to the lower combination index.
        var events = Enumerable.Repeat(((uint)1000, (byte)3), 7)
            .Append(((uint)1001, (byte)3)).ToList();
        var r = Reconciler.Reconcile(events, Res);
        Assert.Single(r.Distinct());
        Assert.Equal(8, r.Count);
    }

    [Fact]
    public void UsesTheGivenResolution()
    {
        // With 50 ns steps the phase difference of 9-7 is 100 ns, not 80.
        Assert.Equal([1000350L, 1000450L], Reconciler.Reconcile([(1000, 7), (1000, 9)], 50));
    }
}

public class CountExtenderTests
{
    [Fact]
    public void NoWrap()
    {
        var ext = new CountExtender();
        Assert.Equal(100UL, ext.Extend(100));
        Assert.Equal(200UL, ext.Extend(200));
        Assert.Equal(200UL, ext.Extend(200));
    }

    [Fact]
    public void Wrap()
    {
        var ext = new CountExtender();
        Assert.Equal(0xFFFFFFF0UL, ext.Extend(0xFFFFFFF0));
        Assert.Equal(0x1_0000_0005UL, ext.Extend(5));
        Assert.Equal(0x1_0000_000AUL, ext.Extend(10));
    }
}

public class GroupEventsTests
{
    private const uint Res = 40;

    private static SourceEvent Ev(string device, byte gp, uint count, byte phase, bool sync) =>
        new(Device: device, Channel: Pins.PinLabel(gp), Inputs: 1U << gp,
            RawCount: count, RawPhase: phase, SyncActive: sync);

    [Fact]
    public void FreeRunningGroupIgnoresPhase()
    {
        var single = Reconciler.GroupEvents([Ev("local", 0, 1000, 9, false)], Res);
        Assert.Equal([1_000_000L], single[0].ReconciledNs);

        var pair = Reconciler.GroupEvents(
            [Ev("local", 0, 1000, 9, false), Ev("local", 1, 1000, 3, false)], Res);
        Assert.Equal([1_000_000L, 1_000_000L], pair[0].ReconciledNs);
    }

    [Fact]
    public void SameDevice2Ch()
    {
        var groups = Reconciler.GroupEvents(
            [Ev("local", 0, 1000, 23, true), Ev("local", 1, 1001, 2, true)], Res);
        Assert.Single(groups);
        Assert.True(groups[0].Reconciled);
        Assert.Equal(2, groups[0].Events.Count);
        Assert.Equal([1000920L, 1001080L], groups[0].ReconciledNs);
    }

    [Fact]
    public void TwoDevices1Ch()
    {
        var groups = Reconciler.GroupEvents(
            [Ev("devA", 0, 1000, 17, true), Ev("devB", 0, 1000, 5, true)], Res);
        Assert.True(groups[0].Reconciled);
    }

    [Fact]
    public void CountGapSplits()
    {
        var groups = Reconciler.GroupEvents(
        [
            Ev("devA", 0, 1000, 17, true),
            Ev("devB", 0, 1000, 5, true),
            Ev("devA", 0, 5000, 3, true),
            Ev("devB", 0, 5001, 0, true),
            Ev("devA", 0, 9000, 8, true),
        ], Res);
        Assert.Equal([2, 2, 1], groups.Select(g => g.Events.Count).ToList());
        Assert.False(groups[2].Reconciled); // K=1
    }

    [Fact]
    public void MixedSyncUncorrected()
    {
        var groups = Reconciler.GroupEvents(
            [Ev("devA", 0, 1000, 17, true), Ev("devB", 0, 1000, 0, false)], Res);
        Assert.False(groups[0].Reconciled);
        Assert.Contains("mixed sync_active", groups[0].Warning);
    }

    [Fact]
    public void Timer0CrossDeviceUncorrected()
    {
        var groups = Reconciler.GroupEvents(
            [Ev("devA", 0, 1000, 0, false), Ev("devB", 0, 1000, 0, false)], Res);
        Assert.False(groups[0].Reconciled);
        Assert.NotNull(groups[0].Warning);
    }

    [Fact]
    public void Timer0SameDeviceReconciled()
    {
        var groups = Reconciler.GroupEvents(
            [Ev("local", 0, 1000, 0, false), Ev("local", 1, 1001, 0, false)], Res);
        Assert.True(groups[0].Reconciled);
    }

    [Fact]
    public void LargeGroupIsLeftAsIsWithAWarning()
    {
        var events = Enumerable.Range(0, 9).Select(i => Ev("local", (byte)i, 1000, 7, true)).ToList();
        var groups = Reconciler.GroupEvents(events, Res);
        Assert.False(groups[0].Reconciled);
        Assert.Contains("exhaustive-search limit", groups[0].Warning);
    }

    [Fact]
    public void BasicNs()
    {
        var groups = Reconciler.GroupEvents(
            [Ev("devA", 0, 100, 5, true), Ev("devB", 0, 100, 9, true)], Res);
        Assert.Equal(100U, groups[0].ApproxCount);
        Assert.Equal([100200L, 100360L], groups[0].ReconciledNs);
    }

    [Fact]
    public void GroupingUsesTheResolutionArgument()
    {
        var groups = Reconciler.GroupEvents(
            [Ev("devA", 0, 100, 5, true), Ev("devB", 0, 100, 9, true)], 50);
        Assert.Equal([100250L, 100450L], groups[0].ReconciledNs);
    }

    [Fact]
    public void ChannelLabelsComeFromThePinHelpers()
    {
        var ev = Ev("local", 26, 1, 0, true);
        Assert.Equal("GP26 (ch23)", ev.Channel);
        Assert.Equal(1U << 26, ev.Inputs);
        Assert.Equal("GP26 (ch23)", ev.SourceLabel());
        Assert.Equal("devA:GP26 (ch23)", (ev with { Device = "devA" }).SourceLabel());
    }
}

public class PairStatsTests
{
    [Fact]
    public void Basic()
    {
        var groups = Reconciler.GroupEvents(
        [
            new SourceEvent("devA", "GP0 (ch0)", 1, 1000, 10, true),
            new SourceEvent("devB", "GP0 (ch0)", 1, 1000, 5, true),
        ], 40);
        var stats = Reconciler.ComputePairStats(groups);
        Assert.Single(stats);
        Assert.Equal(1, stats[0].N);
        Assert.Equal(200, stats[0].MaxAbsDiffNs);
        Assert.Equal(100.0, stats[0].Within500NsPct);
    }
}
