using System.Diagnostics;
using Xunit;

namespace Pochi.Sdk.Tests;

/// <summary>Transport contract (docs/sdk-api-design.md, R-H1 to R-H4): one
/// command one response, counted responses of exactly N lines, resynchronisation
/// with <c>ping</c> after a desync, and event routing. Every line the fake
/// device sends is a line of the golden transcripts (<see cref="G"/> checks
/// that); a test that needs a malformed line is marked
/// <c>Category=Negative</c>.</summary>
public class TransportTests : IDisposable
{
    private const string Negative = "Negative";

    private readonly FakePort _port = new();
    private readonly Transport _transport;
    private readonly List<string> _errors = [];

    public TransportTests()
    {
        _transport = new Transport(_port) { ErrorLog = m => { lock (_errors) { _errors.Add(m); } } };
    }

    public void Dispose() => _port.Closed = true;

    /// <summary>A wire line that must occur verbatim in a golden transcript.</summary>
    internal static string G(string line)
    {
        var found = GoldenCorpus.Cases
            .SelectMany(c => c.Steps)
            .SelectMany(s => s.Response.Append("! " + s.Text))
            .Contains(line);
        Assert.True(found, $"\"{line}\" does not occur in the golden transcripts");
        return line;
    }

    private static string GoldenEvent(string kind) =>
        "! " + GoldenCorpus.Cases.SelectMany(c => c.Steps)
            .First(s => s.Kind == GoldenStepKind.Event
                && s.Text.StartsWith(kind, StringComparison.Ordinal)).Text;

    private static void WaitFor(Func<bool> condition)
    {
        var deadline = Environment.TickCount64 + 2000;
        while (!condition() && Environment.TickCount64 < deadline)
        {
            Thread.Sleep(5);
        }

        Assert.True(condition(), "condition not reached within 2 s");
    }

    private static uint PingToken(string written)
    {
        Assert.StartsWith("ping ", written, StringComparison.Ordinal);
        return uint.Parse(written["ping ".Length..], System.Globalization.CultureInfo.InvariantCulture);
    }

    // --- one command, one response ---

    [Fact]
    public void CommandOk()
    {
        _port.OnCommand = _ => _port.Feed(GoldenCorpus.FirstResponse("version").ToArray());
        Assert.Equal("fw=0.1.3 proto=2", _transport.Command("version"));
        Assert.Equal(["version"], _port.Written);
    }

    [Fact]
    public void CommandSendsCrLfTerminatedLine()
    {
        var raw = new List<string>();
        _port.OnCommand = line => { raw.Add(line); _port.Feed(G("OK")); };
        _transport.Command("map save");
        Assert.Equal(["map save"], raw);
    }

    [Fact]
    public void CommandDeviceError()
    {
        _port.OnCommand = _ => _port.Feed(G("ERR UNKNOWN_CMD"));
        TestHelpers.AssertSdkThrows(ErrorCode.UnknownCmd, () => _transport.Command("version2"));
        Assert.False(_transport.IsDesynced); // an ERR answer is a complete response
    }

    [Fact]
    [Trait("Category", Negative)]
    public void CommandGarbageIsParseErrorAndDesyncs()
    {
        _port.OnCommand = _ => _port.Feed("WHAT IS THIS");
        TestHelpers.AssertSdkThrows(ErrorCode.Parse, () => _transport.Command("version"));
        Assert.True(_transport.IsDesynced);
    }

    [Fact]
    public void CommandTimeoutDesyncs()
    {
        _transport.CommandTimeout = TimeSpan.FromMilliseconds(150);
        TestHelpers.AssertSdkThrows(ErrorCode.Timeout, () => _transport.Command("version"));
        Assert.True(_transport.IsDesynced);
    }

    [Fact]
    public void PartialLineAssembled()
    {
        _port.OnCommand = _ =>
        {
            _port.FeedRaw("OK fw=0.");
            _port.FeedRaw("1.3 proto=2\r\n");
        };
        Assert.Equal("fw=0.1.3 proto=2", _transport.Command("version"));
    }

    [Fact]
    public void BlankLinesAreIgnored()
    {
        _port.OnCommand = _ => _port.Feed("", G("OK"));
        Assert.Equal("", _transport.Command("map save"));
    }

    [Fact]
    public void OneCommandIsNotAnsweredWithAnEarlierQueuedLine()
    {
        // No draining: two commands in a row each consume exactly one response.
        var answers = new Queue<string>([G("OK pong=1"), G("OK pong=2")]);
        _port.OnCommand = _ => _port.Feed(answers.Dequeue());
        Assert.Equal("pong=1", _transport.Command("ping 1"));
        Assert.Equal("pong=2", _transport.Command("ping 2"));
    }

    // --- R-H1: counted responses (count=N) ---

    private static IReadOnlyList<string> GoldenTsGetResponse() =>
        GoldenCorpus.Case("timestamp", "ts under sync").Steps
            .Last(s => s.Text.StartsWith("ts get", StringComparison.Ordinal)).Response;

    [Fact]
    public void CountedReadsExactlyNLines()
    {
        var response = GoldenTsGetResponse();
        Assert.Equal("OK count=4 overflow=0", response[0]);
        _port.OnCommand = _ => _port.Feed(response.ToArray());
        var (data, lines) = _transport.CommandCounted("ts get 10");
        Assert.Equal("count=4 overflow=0", data);
        Assert.Equal(response.Skip(1), lines);
        Assert.Equal("  in=0x00000001 c=2 p=12 s=1", lines[0]); // continuation keeps its 2 spaces
    }

    [Fact]
    public void CountedDoesNotConsumeTheNextResponse()
    {
        // A response that follows the N lines belongs to the next command.
        var response = GoldenTsGetResponse();
        var next = G("OK pong=1");
        _port.OnCommand = line => FeedTsGetThenLeftover(line, response, next);
        var (_, lines) = _transport.CommandCounted("ts get 10");
        Assert.Equal(4, lines.Count);
        WaitFor(() => _transport.PendingResponses == 1); // left queued, not consumed
        // The queued line is stale for the next command, which resyncs first.
        Assert.Equal("pong=1", _transport.Command("ping 1"));
        Assert.Equal(0, _transport.PendingResponses);
    }

    /// <summary>Answers <c>ts get</c> with the response followed by one extra
    /// line, <c>ping 1</c> with its golden pong and a resync ping with its
    /// own token.</summary>
    private void FeedTsGetThenLeftover(string line, IReadOnlyList<string> response, string leftover)
    {
        if (line.StartsWith("ts get", StringComparison.Ordinal))
        {
            _port.Feed([.. response, leftover]);
        }
        else if (line == "ping 1")
        {
            _port.Feed(G("OK pong=1"));
        }
        else
        {
            _port.Feed($"OK pong={PingToken(line)}");
        }
    }

    [Fact]
    public void CountedZeroHasNoContinuationLines()
    {
        _port.OnCommand = _ => _port.Feed(G("OK count=0 overflow=0"));
        var (data, lines) = _transport.CommandCounted("ts get 85");
        Assert.Equal("count=0 overflow=0", data);
        Assert.Empty(lines);
        Assert.False(_transport.IsDesynced);
    }

    [Fact]
    public void CountedErrResponseHasNoLines()
    {
        _port.OnCommand = _ => _port.Feed(G("ERR NOT_ARMED"));
        TestHelpers.AssertSdkThrows(ErrorCode.NotArmed, () => _transport.CommandCounted("ts get 10"));
        Assert.False(_transport.IsDesynced);
    }

    [Fact]
    public void SingleLineCommandIsNotReadAsCounted()
    {
        // `sync count` answers one line (clocks=), never a counted response.
        _port.OnCommand = _ => _port.Feed(G("OK clocks=1000"));
        var sw = Stopwatch.StartNew();
        Assert.Equal("clocks=1000", _transport.Command("sync count"));
        Assert.True(sw.Elapsed < TimeSpan.FromSeconds(1));
    }

    [Fact]
    public void ShortCountedResponseDesyncs()
    {
        var response = GoldenTsGetResponse();
        _transport.CommandTimeout = TimeSpan.FromMilliseconds(150);
        _port.OnCommand = _ => _port.Feed(response.Take(3).ToArray()); // header + 2 of 4 lines
        TestHelpers.AssertSdkThrows(ErrorCode.Timeout, () => _transport.CommandCounted("ts get 10"));
        Assert.True(_transport.IsDesynced);
    }

    // --- Raw: every line of the response ---

    [Fact]
    public void RawReturnsTheWholeCountedResponse()
    {
        var help = GoldenCorpus.FirstResponse("help");
        // One header plus the number of lines the transcript's header announces.
        Assert.StartsWith("OK count=", help[0], StringComparison.Ordinal);
        Assert.Equal(1 + int.Parse(help[0]["OK count=".Length..], System.Globalization.CultureInfo.InvariantCulture), help.Count);
        _port.OnCommand = _ => _port.Feed(help.ToArray());
        Assert.Equal(help, _transport.Raw("help"));
    }

    [Fact]
    public void RawReturnsASingleLineAsReceived()
    {
        _port.OnCommand = _ => _port.Feed(G("ERR UNKNOWN_CMD"));
        Assert.Equal(["ERR UNKNOWN_CMD"], _transport.Raw("frobnicate"));
        _port.OnCommand = _ => _port.Feed(G("OK pong=5"));
        Assert.Equal(["OK pong=5"], _transport.Raw("ping 5"));
        Assert.False(_transport.IsDesynced);
    }

    [Fact]
    public void RawReadsExactlyNLinesAndLeavesTheNextResponseAlone()
    {
        var response = GoldenTsGetResponse();
        _port.OnCommand = line => FeedTsGetThenLeftover(line, response, G("OK pong=1"));
        Assert.Equal(response, _transport.Raw("ts get 10"));
        WaitFor(() => _transport.PendingResponses == 1); // left queued, not consumed
        Assert.Equal(["OK pong=1"], _transport.Raw("ping 1"));
        Assert.Equal(0, _transport.PendingResponses);
    }

    [Fact]
    public void RawRefusesAnOverlongLineAndSendsNothing()
    {
        TestHelpers.AssertSdkThrows(
            ErrorCode.InvalidArgument, () => _transport.Raw("pattern add " + new string('x', 245)));
        Assert.Empty(_port.Written);
        _port.OnCommand = _ => _port.Feed(G("OK pong=1"));
        _transport.Raw("ping " + new string(' ', 245) + "1"); // exactly 251 bytes: allowed
        Assert.Single(_port.Written);
    }

    [Fact]
    public void LineOf256BytesIsSentAnd257IsRefused()
    {
        _port.OnCommand = _ => _port.Feed(G("OK pong=1"));
        _transport.Raw("ping 1" + new string(' ', 250));
        Assert.Equal(256, _port.Written[0].Length);
        TestHelpers.AssertSdkThrows(
            ErrorCode.InvalidArgument, () => _transport.Raw("ping 1" + new string(' ', 251)));
        Assert.Single(_port.Written);
    }

    [Theory]
    [InlineData("read\nversion")]
    [InlineData("read\rversion")]
    public void RawRefusesEmbeddedLineBreaks(string command)
    {
        TestHelpers.AssertSdkThrows(ErrorCode.InvalidArgument, () => _transport.Raw(command));
        Assert.Empty(_port.Written);
    }

    // --- R-H2: resynchronisation ---

    /// <summary>A device that answers <c>ping N</c> with
    /// <c>OK pong=N</c> after emitting <paramref name="beforePong"/>, and
    /// every other command with its golden response.</summary>
    private void DeviceWithStaleLines(string[] beforePong, string readResponse)
    {
        _port.OnCommand = line =>
        {
            if (line.StartsWith("ping ", StringComparison.Ordinal))
            {
                _port.Feed([.. beforePong, $"OK pong={PingToken(line)}"]);
            }
            else
            {
                _port.Feed(readResponse);
            }
        };
    }

    [Fact]
    public void AfterATimeoutTheNextOperationPingsAndDiscardsStaleLines()
    {
        _transport.CommandTimeout = TimeSpan.FromMilliseconds(150);
        _port.OnCommand = _ => { }; // device is silent: the first command times out
        TestHelpers.AssertSdkThrows(ErrorCode.Timeout, () => _transport.Command("read"));

        // The late answers of the timed-out command arrive now, followed by the
        // answer of the ping. All of them are stale except the pong.
        _transport.CommandTimeout = TimeSpan.FromSeconds(2);
        var stale = new[] { G("OK in=0x0000000a"), G("OK total=2"), G("OK count=0 overflow=0") };
        DeviceWithStaleLines(stale, G("OK in=0x00000001"));

        Assert.Equal("in=0x00000001", _transport.Command("read"));
        Assert.Equal(3, _port.Written.Count);
        Assert.Equal("read", _port.Written[0]);
        PingToken(_port.Written[1]);
        Assert.Equal("read", _port.Written[2]);
        Assert.False(_transport.IsDesynced);
    }

    [Fact]
    public void AStaleResponseArrivingWhileIdleIsNotTakenAsTheNextAnswer()
    {
        // A late answer of an earlier command shows up with no command pending.
        // The transport is not flagged desynced, but the queued line must not
        // be consumed as the answer of the next command: it pings first.
        DeviceWithStaleLines([], G("OK in=0x00000001"));
        _port.Feed(G("OK total=2"));
        WaitFor(() => _transport.PendingResponses == 1);
        Assert.False(_transport.IsDesynced);

        Assert.Equal("in=0x00000001", _transport.Command("read"));
        Assert.Equal(2, _port.Written.Count);
        PingToken(_port.Written[0]);
        Assert.Equal("read", _port.Written[1]);
        Assert.Equal(0, _transport.PendingResponses);
    }

    [Fact]
    public void ResyncWorksBeforeEveryKindOfOperation()
    {
        foreach (var operation in new Func<Transport, object>[]
                 {
                     t => t.Command("read"),
                     t => t.CommandCounted("ts get 1"),
                     t => t.Raw("read"),
                 })
        {
            var port = new FakePort();
            using var transport = new Transport(port) { CommandTimeout = TimeSpan.FromMilliseconds(150) };
            port.OnCommand = _ => { };
            Assert.Throws<SdkException>(() => transport.Command("read"));
            transport.CommandTimeout = TimeSpan.FromSeconds(2);
            port.OnCommand = line =>
            {
                if (line.StartsWith("ping ", StringComparison.Ordinal))
                {
                    port.Feed(G("OK in=0x0000000a"), $"OK pong={PingToken(line)}");
                }
                else if (line.StartsWith("ts get", StringComparison.Ordinal))
                {
                    port.Feed(G("OK count=0 overflow=0"));
                }
                else
                {
                    port.Feed(G("OK in=0x00000001"));
                }
            };
            operation(transport);
            Assert.StartsWith("ping ", port.Written[1], StringComparison.Ordinal);
            port.Closed = true;
        }
    }

    [Fact]
    public void AfterAShortCountedResponseTheMissingLinesAreStale()
    {
        var response = GoldenTsGetResponse();
        _transport.CommandTimeout = TimeSpan.FromMilliseconds(150);
        _port.OnCommand = _ => _port.Feed(response.Take(2).ToArray()); // header + 1 of 4 lines
        TestHelpers.AssertSdkThrows(ErrorCode.Timeout, () => _transport.CommandCounted("ts get 10"));

        _transport.CommandTimeout = TimeSpan.FromSeconds(2);
        DeviceWithStaleLines(response.Skip(2).ToArray(), G("OK in=0x00000001"));
        Assert.Equal("in=0x00000001", _transport.Command("read"));
        Assert.False(_transport.IsDesynced);
    }

    [Fact]
    [Trait("Category", Negative)]
    public void AfterAnUnparseableLineTheNextOperationResynchronises()
    {
        _port.OnCommand = _ => _port.Feed("WHAT IS THIS");
        TestHelpers.AssertSdkThrows(ErrorCode.Parse, () => _transport.Command("read"));

        DeviceWithStaleLines([], G("OK in=0x00000001"));
        Assert.Equal("in=0x00000001", _transport.Command("read"));
        Assert.StartsWith("ping ", _port.Written[1], StringComparison.Ordinal);
    }

    [Fact]
    public void AnEarlierPongIsStaleToo()
    {
        _transport.CommandTimeout = TimeSpan.FromMilliseconds(150);
        _port.OnCommand = _ => { };
        Assert.Throws<SdkException>(() => _transport.Command("read"));

        // A pong with another value is a stale line, not the resync reply.
        _transport.CommandTimeout = TimeSpan.FromSeconds(2);
        DeviceWithStaleLines([G("OK pong=5")], G("OK in=0x00000001"));
        Assert.Equal("in=0x00000001", _transport.Command("read"));
    }

    [Fact]
    public void ResyncRoutesEventsToTheEventPath()
    {
        var events = new List<PushEvent>();
        _transport.SetEventCallback(e => { lock (events) { events.Add(e); } });
        _transport.CommandTimeout = TimeSpan.FromMilliseconds(150);
        _port.OnCommand = _ => { };
        Assert.Throws<SdkException>(() => _transport.Command("read"));

        _transport.CommandTimeout = TimeSpan.FromSeconds(2);
        DeviceWithStaleLines([GoldenEvent("INPUT"), G("OK total=2")], G("OK in=0x00000001"));
        Assert.Equal("in=0x00000001", _transport.Command("read"));
        WaitFor(() => { lock (events) { return events.Count == 1; } });
        lock (events)
        {
            Assert.IsType<InputChangeEvent>(events[0]);
        }
    }

    [Fact]
    public void FailedResyncClosesTheConnection()
    {
        var closed = new ManualResetEventSlim();
        _transport.Closed = closed.Set;
        _transport.CommandTimeout = TimeSpan.FromMilliseconds(150);
        _port.OnCommand = _ => { }; // never answers, not even the ping
        Assert.Throws<SdkException>(() => _transport.Command("read"));

        TestHelpers.AssertSdkThrows(ErrorCode.Disconnected, () => _transport.Command("read"));
        Assert.StartsWith("ping ", _port.Written[1], StringComparison.Ordinal);
        Assert.True(closed.Wait(2000), "Closed notification");
        // The connection stays closed.
        TestHelpers.AssertSdkThrows(ErrorCode.Disconnected, () => _transport.Command("read"));
        Assert.Equal(2, _port.Written.Count);
    }

    [Fact]
    public void PingTokensAreRandom()
    {
        var tokens = new HashSet<uint>();
        for (var i = 0; i < 8; i++)
        {
            _transport.MarkDesync();
            _port.OnCommand = line =>
            {
                if (line.StartsWith("ping ", StringComparison.Ordinal))
                {
                    tokens.Add(PingToken(line));
                    _port.Feed($"OK pong={PingToken(line)}");
                }
                else
                {
                    _port.Feed(G("OK"));
                }
            };
            _transport.Command("map save");
        }

        Assert.True(tokens.Count > 1, "ping tokens must not be constant");
    }

    // --- push events ---

    [Fact]
    public void PushInterleavedWithAResponse()
    {
        var events = new List<PushEvent>();
        _transport.SetEventCallback(e => { lock (events) { events.Add(e); } });
        _port.OnCommand = _ => _port.Feed(GoldenEvent("INPUT"), G("OK in=0x00000000"));
        Assert.Equal("in=0x00000000", _transport.Command("read"));
        WaitFor(() => { lock (events) { return events.Count == 1; } });
        lock (events)
        {
            Assert.Equal(
                Protocol.ParsePushEvent(GoldenEvent("INPUT")[2..]), events[0]);
        }
    }

    [Fact]
    public void AllThreeEventKindsAreDelivered()
    {
        var events = new List<PushEvent>();
        _transport.SetEventCallback(e => { lock (events) { events.Add(e); } });
        _port.Feed(GoldenEvent("INPUT"), GoldenEvent("PATTERN_DONE"), GoldenEvent("PATTERN_TIMEOUT"));
        WaitFor(() => { lock (events) { return events.Count == 3; } });
        lock (events)
        {
            Assert.IsType<InputChangeEvent>(events[0]);
            Assert.IsType<PatternDoneEvent>(events[1]);
            Assert.IsType<PatternTimeoutEvent>(events[2]);
        }
    }

    [Fact]
    public void EventsWithoutASubscriberAreDiscardedWithoutAnError()
    {
        _port.Feed(GoldenEvent("PATTERN_DONE"));
        _port.OnCommand = _ => _port.Feed(G("OK"));
        _transport.Command("map save");
        Thread.Sleep(50);
        lock (_errors)
        {
            Assert.Empty(_errors);
        }
    }

    [Fact]
    [Trait("Category", Negative)]
    public void UnknownEventIsLoggedAndNeitherDeliveredNorQueuedAsAResponse()
    {
        var events = new List<PushEvent>();
        _transport.SetEventCallback(e => { lock (events) { events.Add(e); } });
        _port.OnCommand = _ => _port.Feed("! FUTURE_EVENT x=1", G("OK pong=7"));
        // The command receives its own response, not the event line.
        Assert.Equal("pong=7", _transport.Command("ping 7"));
        WaitFor(() => { lock (_errors) { return _errors.Count == 1; } });
        lock (_errors)
        {
            Assert.Contains("FUTURE_EVENT", _errors[0]);
        }

        lock (events)
        {
            Assert.Empty(events);
        }
    }

    [Fact]
    [Trait("Category", Negative)]
    public void MalformedKnownEventIsLoggedAndDropped()
    {
        var events = new List<PushEvent>();
        _transport.SetEventCallback(e => { lock (events) { events.Add(e); } });
        _port.Feed("! INPUT garbage");
        WaitFor(() => { lock (_errors) { return _errors.Count == 1; } });
        lock (events)
        {
            Assert.Empty(events);
        }
    }

    [Fact]
    public void ASubscriberThatThrowsDoesNotKillTheReader()
    {
        var seen = 0;
        _transport.SetEventCallback(_ =>
        {
            if (Interlocked.Increment(ref seen) == 1)
            {
                throw new InvalidOperationException("subscriber bug");
            }
        });
        _port.Feed(GoldenEvent("PATTERN_DONE"), GoldenEvent("PATTERN_DONE"));
        WaitFor(() => Volatile.Read(ref seen) == 2);
        lock (_errors)
        {
            Assert.Contains("subscriber bug", Assert.Single(_errors));
        }

        _port.OnCommand = _ => _port.Feed(G("OK"));
        _transport.Command("map save"); // the reader still runs
    }

    [Fact]
    public void CommandsCannotBeSentFromAnEventCallback()
    {
        Exception? caught = null;
        using var done = new ManualResetEventSlim();
        _transport.SetEventCallback(_ =>
        {
            try
            {
                _transport.Command("read");
            }
            catch (Exception ex)
            {
                caught = ex;
            }
            finally
            {
                done.Set();
            }
        });
        _port.Feed(GoldenEvent("PATTERN_DONE"));
        Assert.True(done.Wait(2000));
        Assert.IsType<InvalidOperationException>(caught);
        Assert.Empty(_port.Written);
    }

    // --- concurrency and lifecycle ---

    [Fact]
    public void ConcurrentCommandsAreSerialised()
    {
        _port.OnCommand = line => _port.Feed($"OK pong={PingToken(line)}");
        var failures = new List<string>();
        var threads = Enumerable.Range(0, 4).Select(t => new Thread(() =>
        {
            for (var i = 0; i < 25; i++)
            {
                var value = (uint)(t * 1000 + i);
                var data = _transport.Command($"ping {value}");
                if (data != $"pong={value}")
                {
                    lock (failures)
                    {
                        failures.Add($"{value}: {data}");
                    }
                }
            }
        })).ToList();
        threads.ForEach(t => t.Start());
        threads.ForEach(t => t.Join());
        Assert.Empty(failures);
        Assert.Equal(100, _port.Written.Count);
    }

    [Fact]
    public void PendingCommandDisconnects()
    {
        _transport.CommandTimeout = TimeSpan.FromSeconds(1);
        _port.Closed = true; // the reader errors out on its next read
        TestHelpers.AssertSdkThrows(ErrorCode.Disconnected, () => _transport.Command("version"));
    }

    [Fact]
    public void SubsequentCommandsDisconnect()
    {
        _port.Closed = true;
        Thread.Sleep(150);
        TestHelpers.AssertSdkThrows(ErrorCode.Disconnected, () => _transport.Command("version"));
    }

    [Fact]
    public void ClosedNotificationFollowsDeviceLoss()
    {
        var closed = new ManualResetEventSlim();
        _transport.Closed = closed.Set;
        _port.Closed = true;
        Assert.True(closed.Wait(2000));
    }
}
