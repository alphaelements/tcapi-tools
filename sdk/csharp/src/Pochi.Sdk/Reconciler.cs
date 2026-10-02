using System.Text.Json.Serialization;

namespace Pochi.Sdk;

/// <summary>One timestamp event tagged with its origin (device x channel).</summary>
public sealed record SourceEvent(
    // Device identifier (UID or "local" for single-device use).
    string Device,
    // Channel label, e.g. "GP26 (ch23)" (see Pins.PinLabel).
    string Channel,
    // Logical levels, physical GP bits.
    uint Inputs,
    uint RawCount,
    byte RawPhase,
    bool SyncActive
)
{
    public string SourceLabel() =>
        Device is "" or "local" ? Channel : $"{Device}:{Channel}";
}

/// <summary>A group of events attributed to the same physical instant.</summary>
public sealed record ReconcileGroup(
    uint ApproxCount,
    IReadOnlyList<SourceEvent> Events,
    IReadOnlyList<long> ReconciledNs,
    // Reconciled is true when a cross-event correction was actually applied.
    bool Reconciled,
    string? Warning
);

/// <summary>Per-source-pair diff statistics across all reconciled groups.</summary>
public sealed record PairStats(
    string A,
    string B,
    int N,
    double MeanDiffNs,
    double StdevNs,
    long MaxAbsDiffNs,
    [property: JsonPropertyName("within_500ns_pct")] double Within500NsPct
);

/// <summary>
/// Host-side timestamp reconciliation. Direct port of
/// <c>sdk/rust/src/reconcile.rs</c> (itself from pochi-cli); must produce
/// identical results for the shared test vectors.
///
/// The device sends raw (count, phase) pairs. Because the three DMA
/// channels (snapshot / count / phase) latch tens of ns apart, count and
/// phase can straddle a µs boundary within one event (~8%). Reconciliation
/// picks, for K events assumed to share one physical instant, the
/// combination of candidate ns values that minimizes total pairwise |diff|.
/// </summary>
public static class Reconciler
{
    /// <summary>Exhaustive search limit: 3^8 = 6561 combinations.</summary>
    public const int MaxExhaustiveK = 8;

    /// <summary>
    /// The three physically possible ns values for one event:
    /// (as-is, count-1, count+1). Always all three — boundary-band
    /// filtering is wrong (±1 count drift occurs even at mid-range phases).
    /// <paramref name="tsResNs"/> is <see cref="Capabilities.TsResNs"/>; the SDK
    /// has no phase-step constant.
    /// </summary>
    public static long[] Candidates(uint count, byte phase, uint tsResNs)
    {
        var baseNs = AsIsNs(count, phase, tsResNs);
        return [baseNs, baseNs - 1000, baseNs + 1000];
    }

    /// <summary>Naive (uncorrected) ns value for one event:
    /// <c>count * 1000 + phase * tsResNs</c>.</summary>
    public static long AsIsNs(uint count, byte phase, uint tsResNs) =>
        count * 1000L + phase * (long)tsResNs;

    /// <summary>
    /// The single definition of an event's nanosecond timestamp (R-TS1). With
    /// the sync clock running it is <see cref="AsIsNs"/>; free running, the
    /// count is TIMER0 microseconds and the phase is ignored.
    /// </summary>
    public static long EventNs(uint count, byte phase, bool syncActive, uint tsResNs) =>
        syncActive ? AsIsNs(count, phase, tsResNs) : count * 1000L;

    private static long PairwiseScore(long[] values)
    {
        long total = 0;
        for (var i = 0; i < values.Length; i++)
        {
            for (var j = i + 1; j < values.Length; j++)
            {
                total += Math.Abs(values[i] - values[j]);
            }
        }

        return total;
    }

    /// <summary>
    /// Reconcile K events assumed to share one physical instant.
    /// Returns one ns value per input event. K=1 and K&gt;<see cref="MaxExhaustiveK"/>
    /// return as-is values. Ties prefer as-is candidates (combination 0
    /// wins on equality).
    /// </summary>
    public static List<long> Reconcile(
        IReadOnlyList<(uint Count, byte Phase)> events, uint tsResNs)
    {
        var k = events.Count;
        if (k == 0)
        {
            return [];
        }

        var cands = events.Select(e => Candidates(e.Count, e.Phase, tsResNs)).ToArray();
        if (k == 1 || k > MaxExhaustiveK)
        {
            return cands.Select(c => c[0]).ToList();
        }

        var bestCombo = 0;
        long? bestScore = null;
        var values = new long[k];
        var total = (int)Math.Pow(3, k);
        for (var combo = 0; combo < total; combo++)
        {
            var rem = combo;
            for (var i = 0; i < k; i++)
            {
                values[i] = cands[i][rem % 3];
                rem /= 3;
            }

            var score = PairwiseScore(values);
            if (bestScore is null || score < bestScore)
            {
                bestScore = score;
                bestCombo = combo;
            }
        }

        var result = new List<long>(k);
        var rest = bestCombo;
        for (var i = 0; i < k; i++)
        {
            result.Add(cands[i][rest % 3]);
            rest /= 3;
        }

        return result;
    }

    /// <summary>
    /// Group events by count proximity (gap &gt;= 2 starts a new group) and
    /// reconcile within each group. Groups that cannot be corrected (K=1,
    /// mixed sync_active, sync_active=0 across devices, K too large) keep
    /// as-is values with a warning.
    /// </summary>
    public static List<ReconcileGroup> GroupEvents(
        IReadOnlyList<SourceEvent> events, uint tsResNs)
    {
        var sorted = events.OrderBy(e => e.RawCount).ThenBy(e => e.RawPhase).ToList();

        var groups = new List<ReconcileGroup>();
        var current = new List<SourceEvent>();
        foreach (var ev in sorted)
        {
            if (current.Count > 0 && ev.RawCount - current[0].RawCount >= 2)
            {
                groups.Add(FinishGroup(current, tsResNs));
                current = [];
            }

            current.Add(ev);
        }

        if (current.Count > 0)
        {
            groups.Add(FinishGroup(current, tsResNs));
        }

        return groups;
    }

    private static ReconcileGroup FinishGroup(List<SourceEvent> events, uint tsResNs)
    {
        var approxCount = events.Count > 0 ? events[0].RawCount : 0;
        var k = events.Count;
        var asIs = events
            .Select(e => EventNs(e.RawCount, e.RawPhase, e.SyncActive, tsResNs))
            .ToList();
        var syncStates = events.Select(e => e.SyncActive).Distinct().Count();
        var devices = events.Select(e => e.Device).Distinct().Count();

        List<long> reconciledNs;
        bool reconciled;
        string? warning;
        if (k == 1)
        {
            (reconciledNs, reconciled, warning) = (asIs, false, null);
        }
        else if (syncStates > 1)
        {
            (reconciledNs, reconciled, warning) = (
                asIs,
                false,
                "mixed sync_active in group; time bases incomparable, no correction applied"
            );
        }
        else if (!events[0].SyncActive && devices > 1)
        {
            (reconciledNs, reconciled, warning) = (
                asIs,
                false,
                "sync_active=0 across different devices; independent TIMER0 bases, "
                    + "no correction applied"
            );
        }
        else if (k > MaxExhaustiveK)
        {
            (reconciledNs, reconciled, warning) = (
                asIs,
                false,
                $"group size {k} exceeds exhaustive-search limit {MaxExhaustiveK}; "
                    + "no correction applied"
            );
        }
        else
        {
            // Free-running events carry no phase; feed 0 so every candidate
            // set matches EventNs.
            var pairs = events
                .Select(e => (e.RawCount, e.SyncActive ? e.RawPhase : (byte)0))
                .ToList();
            (reconciledNs, reconciled, warning) = (Reconcile(pairs, tsResNs), true, null);
        }

        return new ReconcileGroup(approxCount, events, reconciledNs, reconciled, warning);
    }

    /// <summary>Per-source-pair diff statistics across all groups (mean,
    /// stdev, max |diff|, % within 500ns).</summary>
    public static List<PairStats> ComputePairStats(IReadOnlyList<ReconcileGroup> groups)
    {
        var diffs = new Dictionary<(string A, string B), List<long>>();

        foreach (var group in groups)
        {
            for (var i = 0; i < group.Events.Count; i++)
            {
                for (var j = i + 1; j < group.Events.Count; j++)
                {
                    var a = group.Events[i].SourceLabel();
                    var b = group.Events[j].SourceLabel();
                    var d = group.ReconciledNs[i] - group.ReconciledNs[j];
                    if (string.CompareOrdinal(a, b) > 0)
                    {
                        (a, b, d) = (b, a, -d);
                    }

                    if (!diffs.TryGetValue((a, b), out var list))
                    {
                        list = [];
                        diffs[(a, b)] = list;
                    }

                    list.Add(d);
                }
            }
        }

        var stats = new List<PairStats>();
        var ordered = diffs
            .OrderBy(kv => kv.Key.A, StringComparer.Ordinal)
            .ThenBy(kv => kv.Key.B, StringComparer.Ordinal);
        foreach (var ((a, b), ds) in ordered)
        {
            var n = ds.Count;
            var mean = ds.Average();
            var variance = ds.Sum(d => (d - mean) * (d - mean)) / n;
            var maxAbs = ds.Max(Math.Abs);
            var within = ds.Count(d => Math.Abs(d) <= 500) / (double)n * 100.0;
            stats.Add(new PairStats(a, b, n, mean, Math.Sqrt(variance), maxAbs, within));
        }

        return stats;
    }
}

/// <summary>Extends u32 raw counts (wrap ~71.6 min) to 64 bits by tracking
/// wraps. One independent instance per device per count source.</summary>
public sealed class CountExtender
{
    private ulong _high;
    private uint _lastRaw;

    public ulong Extend(uint raw)
    {
        if (raw < _lastRaw)
        {
            _high += 1;
        }

        _lastRaw = raw;
        return (_high << 32) | raw;
    }
}
