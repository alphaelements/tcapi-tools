using Xunit;

namespace Pochi.Sdk.Tests;

// Conformance of the SDK against the golden transcripts in protocol/golden
// (the files the firmware and the simulator replay, docs/sdk-api-design.md
// section 8). Both replays run every transcript test case; a case that sends
// raw bytes (~ send_hex) is skipped because a line-oriented host API cannot
// express it.

public class GoldenCorpusTests
{
    [Fact]
    public void EveryFileIsLoadedAndHasCases()
    {
        foreach (var file in GoldenCorpus.Files)
        {
            Assert.True(
                GoldenCorpus.Cases.Count(c => c.File == file) >= 5,
                $"{file}.txt yielded fewer than 5 cases");
        }

        Assert.True(GoldenCorpus.Cases.Count > 250, "golden corpus looks truncated");
    }

    [Fact]
    public void HeaderOfEveryFileDeclaresProto2()
    {
        foreach (var file in GoldenCorpus.Files)
        {
            var header = File.ReadLines(Path.Combine(GoldenCorpus.Directory, file + ".txt"))
                .Take(3).ToList();
            Assert.Equal("# proto=2", header[0]);
            Assert.StartsWith("# generated_by=", header[1], StringComparison.Ordinal);
            Assert.StartsWith("# fw_commit=", header[2], StringComparison.Ordinal);
        }
    }

    [Fact]
    public void ParserSplitsCasesAndKeepsContinuationLines()
    {
        var cases = GoldenCorpus.Parse("x", [
            "# proto=2",
            "# header",
            "",
            "# --- first ---",
            "~ advance us=1",
            "> ts get 2",
            "< OK count=2 overflow=0",
            "<   in=0x00000001 c=1 p=0 s=0",
            "<   in=0x00000000 c=2 p=0 s=0",
            "< ! INPUT in=0x00000001 t=5",
            "> ping 1",
            "< OK pong=1",
            "",
            "# --- second ---",
            "> version",
            "< OK fw=0.1.3 proto=2",
        ]);
        Assert.Equal(["first", "second"], cases.Select(c => c.Title));
        var steps = cases[0].Steps;
        Assert.Equal(
            [GoldenStepKind.Directive, GoldenStepKind.Request, GoldenStepKind.Event,
                GoldenStepKind.Request],
            steps.Select(s => s.Kind));
        Assert.Equal(
            ["OK count=2 overflow=0", "  in=0x00000001 c=1 p=0 s=0", "  in=0x00000000 c=2 p=0 s=0"],
            steps[1].Response);
        Assert.Equal("INPUT in=0x00000001 t=5", steps[2].Text);
        Assert.Equal(["OK pong=1"], steps[3].Response);
        Assert.Equal(5, cases[0].FirstLine);
    }

    [Theory]
    [InlineData("WRITE 10 15", "write 10 15")]
    [InlineData("write 0xa 0xf", "write 10 15")]
    [InlineData("pattern add 0x1:5 0xA:010", "pattern add 1:5 10:10")]
    [InlineData("map set v=2 flags=0x00 dir=0xF", "map set dir=15 flags=0")]
    [InlineData("map set edge=0x1 dir=0x0", "map set dir=0 edge=1")]
    [InlineData("pattern run once 3", "pattern run once")]
    [InlineData("pattern run loop 3", "pattern run loop 3")]
    [InlineData("  Ts   ARM  0x1   Both ", "ts arm 1 both")]
    public void NormalizeTreatsEquivalentSpellingsAlike(string request, string expected) =>
        Assert.Equal(expected, GoldenCorpus.Normalize(request));

    [Fact]
    public void NormalizeKeepsDifferentRequestsApart()
    {
        Assert.NotEqual(GoldenCorpus.Normalize("write 1 2"), GoldenCorpus.Normalize("write 2 1"));
        Assert.NotEqual(
            GoldenCorpus.Normalize("pattern run loop 3"),
            GoldenCorpus.Normalize("pattern run loop 4"));
    }
}

public class GoldenReplayTests
{
    public static IEnumerable<object[]> Files() => GoldenCorpus.Files.Select(f => new object[] { f });

    // Each (file, mode) is replayed once; the per-file tests and the corpus
    // total below share the result.
    private static readonly System.Collections.Concurrent.ConcurrentDictionary<
        (string File, ReplayMode Mode), Lazy<ReplayStats>> Replays = new();

    private static ReplayStats ReplayFile(string file, ReplayMode mode) =>
        Replays.GetOrAdd((file, mode), key => new Lazy<ReplayStats>(() =>
        {
            var stats = new ReplayStats();
            foreach (var goldenCase in GoldenCorpus.Cases.Where(c => c.File == key.File))
            {
                GoldenReplay.Run(goldenCase, key.Mode, stats);
            }

            return stats;
        })).Value;

    private static ReplayStats Total(ReplayMode mode)
    {
        var total = new ReplayStats();
        foreach (var stats in GoldenCorpus.Files.Select(f => ReplayFile(f, mode)))
        {
            total.Cases += stats.Cases;
            total.SkippedCases += stats.SkippedCases;
            total.Requests += stats.Requests;
            total.Typed += stats.Typed;
            total.RawFallback += stats.RawFallback;
            total.LocalRejects += stats.LocalRejects;
            total.RepeatedSubscribe += stats.RepeatedSubscribe;
            total.Events += stats.Events;
        }

        return total;
    }

    /// <summary>Transport conformance: every request is sent verbatim through
    /// <see cref="Transport.Raw"/>, the device answers with the recorded lines,
    /// counted responses and events are framed exactly, and every OK response
    /// parses with its typed parser.</summary>
    [Theory]
    [MemberData(nameof(Files))]
    public void RawReplayConformsToTheTranscripts(string file)
    {
        var stats = ReplayFile(file, ReplayMode.Raw);
        Assert.True(stats.Requests > 0);
    }

    /// <summary>API conformance: every request that the typed API expresses is
    /// sent by the typed method, and what it returns re-encodes to the recorded
    /// response; a host-side refusal must coincide with a recorded ERR; every
    /// recorded event reaches the subscriber.</summary>
    [Theory]
    [MemberData(nameof(Files))]
    public void TypedReplayConformsToTheTranscripts(string file)
    {
        var stats = ReplayFile(file, ReplayMode.Typed);
        Assert.True(stats.Requests > 0);
    }

    [Fact]
    public void ReplayCoversTheWholeCorpus()
    {
        var raw = Total(ReplayMode.Raw);
        var typed = Total(ReplayMode.Typed);

        // Only the byte-level cases are skipped, and there are some.
        Assert.Equal(GoldenCorpus.Cases.Count(c => c.HasSendHex), raw.SkippedCases);
        Assert.Equal(raw.SkippedCases, typed.SkippedCases);
        Assert.InRange(raw.SkippedCases, 1, 30);
        Assert.Equal(GoldenCorpus.Cases.Count - raw.SkippedCases, raw.Cases);

        // The corpus is large and the typed API carries most of it.
        Assert.True(raw.Requests > 900, $"raw replayed {raw.Requests} requests");
        Assert.Equal(raw.Requests, typed.Requests);
        Assert.True(typed.Typed > raw.Requests / 2, $"typed API replayed {typed.Typed} requests");
        Assert.True(raw.Events > 20, $"{raw.Events} events replayed");
        Assert.True(typed.Events > 10, $"{typed.Events} subscribed events replayed");
        Assert.True(typed.LocalRejects > 20, "host-side validation never refused anything");
        Assert.True(typed.RepeatedSubscribe > 0);
    }
}
