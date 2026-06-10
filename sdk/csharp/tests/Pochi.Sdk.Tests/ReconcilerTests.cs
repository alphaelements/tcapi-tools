using Xunit;

namespace Pochi.Sdk.Tests;

// Reconcile test vectors ported verbatim from the Rust reference
// (sdk/rust/src/reconcile.rs); all SDKs must produce identical results.

public class CandidatesTests
{
    [Fact]
    public void Basic() =>
        Assert.Equal(new long[] { 1000280, 999280, 1001280 },
            Reconciler.Candidates(1000, 7));

    [Fact]
    public void CountZero() =>
        Assert.Equal(new long[] { 280, -720, 1280 }, Reconciler.Candidates(0, 7));

    [Fact]
    public void PhaseBounds()
    {
        Assert.Equal(new long[] { 1000000, 999000, 1001000 },
            Reconciler.Candidates(1000, 0));
        Assert.Equal(new long[] { 1000960, 999960, 1001960 },
            Reconciler.Candidates(1000, 24));
    }
}

public class ReconcileTests
{
    [Fact]
    public void K1AsIs() =>
        Assert.Equal([1000280L], Reconciler.Reconcile([(1000, 7)]));

    [Fact]
    public void K2NoCrossing() =>
        Assert.Equal([1000280L, 1000360L], Reconciler.Reconcile([(1000, 7), (1000, 9)]));

    [Fact]
    public void K2CountMinus1() =>
        Assert.Equal([1000080L, 1000080L], Reconciler.Reconcile([(1001, 2), (1000, 2)]));

    [Fact]
    public void K2CountPlus1() =>
        Assert.Equal([1000920L, 1000920L], Reconciler.Reconcile([(999, 23), (1000, 23)]));

    [Fact]
    public void K2BothShifted()
    {
        var r = Reconciler.Reconcile([(1001, 1), (999, 24)]);
        Assert.Equal([1000040L, 999960L], r);
        Assert.True(Math.Abs(r[0] - r[1]) <= 100);
    }

    [Fact]
    public void K3() =>
        Assert.Equal([1000040L, 1000040L, 1000080L],
            Reconciler.Reconcile([(1000, 1), (1001, 1), (1000, 2)]));

    [Fact]
    public void K4()
    {
        Assert.Equal([1000920L, 1001040L, 1000960L, 1000880L],
            Reconciler.Reconcile([(1000, 23), (1001, 1), (1000, 24), (1000, 22)]));
        Assert.Equal([999960L, 999960L, 999920L, 999880L],
            Reconciler.Reconcile([(999, 24), (1000, 24), (999, 23), (999, 22)]));
    }

    [Fact]
    public void TiePrefersAsIs() =>
        Assert.Equal([1000280L, 1000280L], Reconciler.Reconcile([(1000, 7), (1000, 7)]));

    [Fact]
    public void KTooLargeAsIs() =>
        Assert.Equal(Enumerable.Repeat(1000280L, 9).ToList(),
            Reconciler.Reconcile(Enumerable.Repeat(((uint)1000, (byte)7), 9).ToList()));
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
    private static SourceEvent Ev(string device, string channel, uint count, byte phase,
        bool sync) =>
        new(Device: device, Channel: channel, Inputs: "0x00000001",
            RawCount: count, RawPhase: phase, SyncActive: sync);

    [Fact]
    public void SameDevice2Ch()
    {
        var groups = Reconciler.GroupEvents(
            [Ev("local", "GP0", 1000, 23, true), Ev("local", "GP1", 1001, 2, true)]);
        Assert.Single(groups);
        Assert.True(groups[0].Reconciled);
        Assert.Equal(2, groups[0].Events.Count);
    }

    [Fact]
    public void TwoDevices1Ch()
    {
        var groups = Reconciler.GroupEvents(
            [Ev("devA", "GP0", 1000, 17, true), Ev("devB", "GP0", 1000, 5, true)]);
        Assert.True(groups[0].Reconciled);
    }

    [Fact]
    public void CountGapSplits()
    {
        var groups = Reconciler.GroupEvents(
        [
            Ev("devA", "GP0", 1000, 17, true),
            Ev("devB", "GP0", 1000, 5, true),
            Ev("devA", "GP0", 5000, 3, true),
            Ev("devB", "GP0", 5001, 0, true),
            Ev("devA", "GP0", 9000, 8, true),
        ]);
        Assert.Equal([2, 2, 1], groups.Select(g => g.Events.Count).ToList());
        Assert.False(groups[2].Reconciled); // K=1
    }

    [Fact]
    public void MixedSyncUncorrected()
    {
        var groups = Reconciler.GroupEvents(
            [Ev("devA", "GP0", 1000, 17, true), Ev("devB", "GP0", 1000, 0, false)]);
        Assert.False(groups[0].Reconciled);
        Assert.Contains("mixed sync_active", groups[0].Warning);
    }

    [Fact]
    public void Timer0CrossDeviceUncorrected()
    {
        var groups = Reconciler.GroupEvents(
            [Ev("devA", "GP0", 1000, 0, false), Ev("devB", "GP0", 1000, 0, false)]);
        Assert.False(groups[0].Reconciled);
        Assert.NotNull(groups[0].Warning);
    }

    [Fact]
    public void Timer0SameDeviceReconciled()
    {
        var groups = Reconciler.GroupEvents(
            [Ev("local", "GP0", 1000, 0, false), Ev("local", "GP1", 1001, 0, false)]);
        Assert.True(groups[0].Reconciled);
    }

    [Fact]
    public void BasicNs()
    {
        var groups = Reconciler.GroupEvents(
            [Ev("devA", "GP0", 100, 5, true), Ev("devB", "GP0", 100, 9, true)]);
        Assert.Equal(100U, groups[0].ApproxCount);
        Assert.Equal([100200L, 100360L], groups[0].ReconciledNs);
    }
}

public class PairStatsTests
{
    [Fact]
    public void Basic()
    {
        var groups = Reconciler.GroupEvents(
        [
            new SourceEvent("devA", "GP0", "0x00000001", 1000, 10, true),
            new SourceEvent("devB", "GP0", "0x00000001", 1000, 5, true),
        ]);
        var stats = Reconciler.ComputePairStats(groups);
        Assert.Single(stats);
        Assert.Equal(1, stats[0].N);
        Assert.Equal(200, stats[0].MaxAbsDiffNs);
        Assert.Equal(100.0, stats[0].Within500NsPct);
    }
}
