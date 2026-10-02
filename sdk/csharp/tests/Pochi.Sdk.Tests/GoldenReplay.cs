using System.Globalization;
using Xunit;

namespace Pochi.Sdk.Tests;

internal enum ReplayMode
{
    /// <summary>Every request goes through <see cref="Transport.Raw"/>: the
    /// framing conformance (counted responses, events) of the transport.</summary>
    Raw,

    /// <summary>Every request that the typed API can express goes through the
    /// typed <see cref="Connection"/> method; the rest through
    /// <see cref="Connection.Raw"/>.</summary>
    Typed,
}

internal sealed class ReplayStats
{
    public int Cases;
    public int SkippedCases;
    public int Requests;
    public int Typed;
    public int RawFallback;
    public int LocalRejects;
    public int RepeatedSubscribe;
    public int Events;
}

/// <summary>Replays golden test cases against the SDK over a
/// <see cref="GoldenFw"/> and asserts that the SDK sends the recorded request,
/// that it returns what the recorded response says, and that every recorded
/// event reaches its subscriber. A case that sends raw bytes is skipped: a
/// line-oriented host API cannot express it.</summary>
internal static class GoldenReplay
{
    private sealed class EventCollector : IObserver<PushEvent>
    {
        public List<PushEvent> Events { get; } = [];

        public int Count
        {
            get
            {
                lock (Events)
                {
                    return Events.Count;
                }
            }
        }

        public void OnNext(PushEvent value)
        {
            lock (Events)
            {
                Events.Add(value);
            }
        }

        public void OnCompleted()
        {
        }

        public void OnError(Exception error)
        {
        }
    }

    private static void WaitFor(Func<bool> condition, string what)
    {
        var deadline = Environment.TickCount64 + 3000;
        while (!condition())
        {
            Assert.True(Environment.TickCount64 < deadline, $"timed out waiting for {what}");
            Thread.Sleep(2);
        }
    }

    public static void Run(GoldenCase goldenCase, ReplayMode mode, ReplayStats stats)
    {
        if (goldenCase.HasSendHex)
        {
            stats.SkippedCases++;
            return;
        }

        stats.Cases++;
        var fw = new GoldenFw(goldenCase) { Exact = mode == ReplayMode.Raw };
        if (mode == ReplayMode.Raw)
        {
            RunRaw(goldenCase, fw, stats);
        }
        else
        {
            RunTyped(goldenCase, fw, stats);
        }

        Assert.Empty(fw.Mismatches);
        Assert.True(fw.Finished, $"{goldenCase}: not every recorded request was replayed");
    }

    // --- raw mode: transport framing ---

    private static void RunRaw(GoldenCase goldenCase, GoldenFw fw, ReplayStats stats)
    {
        using var transport = new Transport(fw.Port);
        var collector = new EventCollector();
        transport.SetEventCallback(collector.OnNext);
        var expectedEvents = new List<PushEvent>();

        foreach (var step in goldenCase.Steps.Where(s => s.Kind == GoldenStepKind.Request))
        {
            foreach (var payload in fw.PumpEvents())
            {
                expectedEvents.Add(Protocol.ParsePushEvent(payload));
            }

            stats.Requests++;
            var written = fw.Port.Written.Count;
            IReadOnlyList<string> lines;
            try
            {
                lines = transport.Raw(step.Text);
            }
            catch (SdkException ex) when (ex.Code == ErrorCode.InvalidArgument)
            {
                // Refused locally (line over 256 bytes): the device would
                // answer ERR LINE_TOO_LONG, which is what the transcript records.
                Assert.Equal(written, fw.Port.Written.Count);
                AssertErr(goldenCase, step, "LINE_TOO_LONG");
                fw.Skip();
                stats.LocalRejects++;
                continue;
            }

            Assert.True(
                step.Response.SequenceEqual(lines),
                $"{goldenCase} line {step.Line}: {step.Text}\n"
                    + $"expected: {string.Join(" | ", step.Response)}\n"
                    + $"actual:   {string.Join(" | ", lines)}");
            VerifyOkParses(step, lines);
        }

        foreach (var payload in fw.PumpEvents())
        {
            expectedEvents.Add(Protocol.ParsePushEvent(payload));
        }

        WaitFor(() => collector.Count >= expectedEvents.Count, "events");
        stats.Events += expectedEvents.Count;
        lock (collector.Events)
        {
            Assert.Equal(expectedEvents, collector.Events);
        }

        fw.Port.Closed = true; // wakes the reader so disposing does not wait for its poll
    }

    /// <summary>Every OK response the golden files record parses with the typed
    /// parser of its request form, and re-encodes to the same text where the
    /// SDK can encode it.</summary>
    private static void VerifyOkParses(GoldenStep step, IReadOnlyList<string> lines)
    {
        if (!lines[0].StartsWith("OK", StringComparison.Ordinal))
        {
            return;
        }

        var data = lines[0].Length > 3 ? lines[0][3..] : "";
        var words = step.Text.Split(new[] { ' ', '\t' }, StringSplitOptions.RemoveEmptyEntries)
            .Select(w => w.ToLowerInvariant())
            .ToArray();
        var form = words.Length > 1 && words[0] is "map" or "pattern" or "ts" or "sync"
            ? $"{words[0]} {words[1]}"
            : words.FirstOrDefault() ?? "";
        switch (form)
        {
            case "version":
                Assert.Equal(Pins.ProtoVersion, Protocol.ParseVersion(data).ProtocolVersion);
                break;
            case "caps":
                Protocol.ParseCaps(data);
                break;
            case "info":
                Protocol.ParseInfo(data);
                break;
            case "ping":
                Protocol.ParsePong(data);
                break;
            case "read":
                Protocol.ParseRead(data);
                break;
            case "state":
                Protocol.ParseState(data);
                break;
            case "map get":
                Assert.Equal(data, PinMap.ParseGet(data).ToSetArgs());
                break;
            case "pattern add":
                Protocol.ParsePatternTotal(data);
                break;
            case "pattern status":
                Protocol.ParsePatternStatus(data);
                break;
            case "ts get":
                {
                    var (count, _) = Protocol.ParseTsGetHeader(data);
                    Assert.Equal((int)count, lines.Count - 1);
                    foreach (var line in lines.Skip(1))
                    {
                        Protocol.ParseTsEventLine(line);
                    }

                    break;
                }

            case "ts status":
                Protocol.ParseTsStatus(data);
                break;
            case "sync count":
                Protocol.ParseSyncCount(data);
                break;
        }
    }

    private static void AssertErr(GoldenCase goldenCase, GoldenStep step, params string[] names)
    {
        Assert.True(
            step.Response.Count == 1
                && names.Select(n => "ERR " + n).Contains(step.Response[0]),
            $"{goldenCase} line {step.Line}: the host refused \"{Shorten(step.Text)}\" locally "
                + $"but the device answer is {string.Join(" | ", step.Response)} "
                + $"(expected ERR {string.Join(" or ERR ", names)})");
    }

    private static string Shorten(string s) => s.Length <= 60 ? s : s[..60] + "...";

    // --- typed mode: the typed API ---

    private static void RunTyped(GoldenCase goldenCase, GoldenFw fw, ReplayStats stats)
    {
        using var conn = fw.Connect();
        var collector = new EventCollector();
        IDisposable? subscription = null;
        var expectedEvents = 0;

        void Pump()
        {
            var fed = fw.PumpEvents();
            if (subscription is not null)
            {
                expectedEvents += fed.Count;
                WaitFor(() => collector.Count >= expectedEvents, "subscribed events");
                stats.Events += fed.Count;
            }
        }

        foreach (var step in goldenCase.Steps.Where(s => s.Kind == GoldenStepKind.Request))
        {
            Pump();
            stats.Requests++;
            var words = Words(step.Text);

            if (words.Length >= 1 && words[0] == "subscribe")
            {
                subscription = ReplaySubscribe(
                    goldenCase, fw, conn, collector, subscription, step, words, stats);
                continue;
            }

            var written = fw.Port.Written.Count;
            var outcome = TypedDispatch.Execute(conn, words);
            if (outcome is null)
            {
                stats.RawFallback++;
                IReadOnlyList<string> lines;
                try
                {
                    lines = conn.Raw(step.Text);
                }
                catch (SdkException ex) when (ex.Code == ErrorCode.InvalidArgument)
                {
                    Assert.Equal(written, fw.Port.Written.Count);
                    AssertErr(goldenCase, step, "LINE_TOO_LONG");
                    fw.Skip();
                    stats.LocalRejects++;
                    continue;
                }

                Assert.Equal(step.Response, lines);
                continue;
            }

            stats.Typed++;
            switch (outcome.Kind)
            {
                case TypedKind.LocalReject:
                    Assert.Equal(written, fw.Port.Written.Count);
                    if (step.Text.Length > Protocol.MaxLineBytes)
                    {
                        AssertErr(goldenCase, step, "LINE_TOO_LONG");
                    }
                    else
                    {
                        AssertErr(goldenCase, step, "BAD_PARAM", "BAD_MAP");
                    }

                    fw.Skip();
                    stats.LocalRejects++;
                    break;

                case TypedKind.DeviceError:
                    Assert.True(
                        step.Response.Count == 1
                            && step.Response[0].StartsWith("ERR ", StringComparison.Ordinal),
                        $"{goldenCase} line {step.Line}: the SDK reported a device error but "
                            + $"the transcript answers {string.Join(" | ", step.Response)}");
                    Assert.Equal(
                        SdkException.FromDeviceError(step.Response[0][4..]).Code, outcome.Code);
                    Assert.False(
                        words is ["map", "set", ..] && step.Response[0] == "ERR BAD_MAP",
                        $"{goldenCase} line {step.Line}: the SDK sent a map the firmware "
                            + "rejects with BAD_MAP; PinMap.Validate has a gap");
                    break;

                case TypedKind.Ok:
                    Assert.True(
                        step.Response.SequenceEqual(outcome.Lines),
                        $"{goldenCase} line {step.Line}: {step.Text}\n"
                            + $"expected: {string.Join(" | ", step.Response)}\n"
                            + $"actual:   {string.Join(" | ", outcome.Lines)}");
                    break;
            }
        }

        Pump();
        fw.Port.Closed = true; // wakes the reader so disposing does not wait for its poll
    }

    private static string[] Words(string request) =>
        request.Split(new[] { ' ', '\t' }, StringSplitOptions.RemoveEmptyEntries)
            .Select(w => w.ToLowerInvariant())
            .ToArray();

    /// <summary>The SDK owns <c>subscribe</c>: <c>subscribe on</c> is the first
    /// subscriber attaching, <c>subscribe off</c> the last one leaving. A
    /// repeated form has no SDK equivalent (the second subscriber shares the
    /// first subscription) and every other spelling is refused locally.</summary>
    private static IDisposable? ReplaySubscribe(
        GoldenCase goldenCase, GoldenFw fw, Connection conn, EventCollector collector,
        IDisposable? subscription, GoldenStep step, string[] words, ReplayStats stats)
    {
        var written = fw.Port.Written.Count;
        if (words is ["subscribe", "on"])
        {
            if (subscription is not null)
            {
                Assert.Equal("OK", step.Response[0]);
                fw.Skip();
                stats.RepeatedSubscribe++;
                return subscription;
            }

            try
            {
                var attached = conn.Events.Subscribe(collector);
                Assert.Equal(new[] { "OK" }, step.Response);
                return attached;
            }
            catch (SdkException ex)
            {
                Assert.StartsWith("ERR ", step.Response[0], StringComparison.Ordinal);
                Assert.Equal(
                    SdkException.FromDeviceError(step.Response[0][4..]).Code, ex.Code);
                return null;
            }
        }

        if (words is ["subscribe", "off"])
        {
            if (subscription is null)
            {
                Assert.Equal("OK", step.Response[0]);
                fw.Skip();
                stats.RepeatedSubscribe++;
                return null;
            }

            subscription.Dispose();
            Assert.Equal(new[] { "OK" }, step.Response);
            return null;
        }

        // Any other spelling of subscribe: refused by Raw before sending.
        var ex2 = Assert.Throws<SdkException>(() => conn.Raw(step.Text));
        Assert.Equal(ErrorCode.InvalidArgument, ex2.Code);
        Assert.Equal(written, fw.Port.Written.Count);
        AssertErr(goldenCase, step, "BAD_PARAM", "UNKNOWN_CMD");
        fw.Skip();
        stats.LocalRejects++;
        return subscription;
    }
}

internal enum TypedKind
{
    Ok,
    LocalReject,
    DeviceError,
}

internal sealed record TypedOutcome(
    TypedKind Kind, IReadOnlyList<string> Lines, ErrorCode Code = default);

/// <summary>Maps a recorded request onto the typed <see cref="Connection"/>
/// method that sends it, and re-encodes the typed result as the response
/// lines the protocol prints. Returns null when the typed API cannot express
/// the request (a number the typed signature does not accept, a malformed or
/// removed form).</summary>
internal static class TypedDispatch
{
    private static bool Num(string s, out uint value)
    {
        value = 0;
        if (s.StartsWith("0x", StringComparison.Ordinal))
        {
            return s.Length > 2 && s.Skip(2).All(char.IsAsciiHexDigit)
                && uint.TryParse(s[2..], NumberStyles.AllowHexSpecifier,
                    CultureInfo.InvariantCulture, out value);
        }

        return s.Length > 0 && s.All(char.IsAsciiDigit)
            && uint.TryParse(s, NumberStyles.None, CultureInfo.InvariantCulture, out value);
    }

    private static string[] Ok(string? data = null) =>
        [data is null ? "OK" : "OK " + data];

    private static string Hex(uint v) => $"0x{v:x8}";

    private static TypedOutcome Run(Func<string[]> call)
    {
        try
        {
            return new TypedOutcome(TypedKind.Ok, call());
        }
        catch (SdkException ex) when (ex.Code == ErrorCode.InvalidArgument)
        {
            return new TypedOutcome(TypedKind.LocalReject, []);
        }
        catch (SdkException ex) when (IsDeviceError(ex.Code))
        {
            return new TypedOutcome(TypedKind.DeviceError, [], ex.Code);
        }
    }

    /// <summary>The codes that map an <c>ERR &lt;NAME&gt;</c> answer.</summary>
    private static bool IsDeviceError(ErrorCode code) => code is
        ErrorCode.BadParam or ErrorCode.BadMap or ErrorCode.Busy or ErrorCode.Flash
        or ErrorCode.TooLong or ErrorCode.NotArmed or ErrorCode.SyncState
        or ErrorCode.NoResource or ErrorCode.NotRunning or ErrorCode.UnknownCmd
        or ErrorCode.LineTooLong or ErrorCode.BadCommand
        or ErrorCode.TransportNotSupported or ErrorCode.UnknownDevice;

    public static TypedOutcome? Execute(Connection c, string[] w)
    {
        switch (w)
        {
            case ["version"]:
                return Run(() =>
                {
                    var v = c.Version();
                    return Ok($"fw={v.Major}.{v.Minor}.{v.Patch} proto={v.ProtocolVersion}");
                });
            case ["caps"]:
                return Run(() =>
                {
                    var k = c.Caps();
                    return Ok($"dio={k.Dio} out={k.Out} in={k.In} ts_res_ns={k.TsResNs} "
                        + $"tick_ns={k.TickNs} pattern={k.PatternMax} ring={k.Ring} "
                        + $"feat={Hex(k.Features)}");
                });
            case ["info"]:
                return Run(() =>
                {
                    var i = c.Info();
                    return Ok($"uid={i.Uid} devnum={i.DeviceNumber ?? 255}");
                });
            case ["devnum", var n] when Num(n, out var devnum) && devnum <= byte.MaxValue:
                return Run(() =>
                {
                    c.SetDeviceNumber((byte)devnum);
                    return Ok();
                });
            case ["ping", var p] when Num(p, out var ping):
                return Run(() => Ok($"pong={c.Ping(ping)}"));
            case ["map", "get"]:
                return Run(() => Ok(c.MapGet().ToSetArgs()));
            case ["map", "set", .. var kv]:
                return MapSet(c, kv);
            case ["map", "save"]:
                return Run(() =>
                {
                    c.MapSave();
                    return Ok();
                });
            case ["map", "default"]:
                return Run(() =>
                {
                    c.MapDefault();
                    return Ok();
                });
            case ["read"]:
                return Run(() => Ok($"in={Hex(c.Read())}"));
            case ["state"]:
                return Run(() =>
                {
                    var s = c.State();
                    return Ok($"in={Hex(s.Inputs)} out={Hex(s.Outputs)}");
                });
            case ["write", var v, var m] when Num(v, out var values) && Num(m, out var mask):
                return Run(() =>
                {
                    c.Write(values, mask);
                    return Ok();
                });
            case ["pattern", "add", .. var steps] when steps.Length > 0:
                return PatternAdd(c, steps);
            case ["pattern", "run", "once"]:
            case ["pattern", "run", "once", _] when Num(w[3], out _):
                return Run(() =>
                {
                    c.PatternRun(PatternMode.Once, 1);
                    return Ok();
                });
            case ["pattern", "run", "loop", var r] when Num(r, out var repeat) && repeat <= ushort.MaxValue:
                return Run(() =>
                {
                    c.PatternRun(PatternMode.Loop, (ushort)repeat);
                    return Ok();
                });
            case ["pattern", "stop"]:
                return Run(() =>
                {
                    c.PatternStop();
                    return Ok();
                });
            case ["pattern", "reset"]:
                return Run(() =>
                {
                    c.PatternReset();
                    return Ok();
                });
            case ["pattern", "status"]:
                return Run(() =>
                {
                    var s = c.PatternStatus();
                    return Ok($"state={s.State.ToString().ToLowerInvariant()} step={s.Step} "
                        + $"loops={s.Loops} total={s.Total}");
                });
            case ["ts", "arm", var m, var mode]
                when Num(m, out var armMask) && ParseEdge(mode) is { } edge:
                return Run(() =>
                {
                    c.TsArm(armMask, edge);
                    return Ok();
                });
            case ["ts", "get", var n] when Num(n, out var max) && max <= ushort.MaxValue:
                return Run(() =>
                {
                    var r = c.TsGet((ushort)max);
                    return
                    [
                        $"OK count={r.Events.Count} overflow={(r.Overflow ? 1 : 0)}",
                        .. r.Events.Select(e => $"  in={Hex(e.Inputs)} c={e.RawCount} "
                            + $"p={e.RawPhase} s={(e.SyncActive ? 1 : 0)}"),
                    ];
                });
            case ["ts", "status"]:
                return Run(() =>
                {
                    var s = c.TsStatus();
                    return Ok($"armed={(s.Armed ? 1 : 0)} pending={s.Pending} "
                        + $"overflow={(s.Overflow ? 1 : 0)}");
                });
            case ["ts", "disarm"]:
                return Run(() =>
                {
                    c.TsDisarm();
                    return Ok();
                });
            case ["sync", "arm"]:
                return Run(() =>
                {
                    c.SyncArm();
                    return Ok();
                });
            case ["sync", "master"]:
                return Run(() =>
                {
                    c.SyncMaster();
                    return Ok();
                });
            case ["sync", "start"]:
                return Run(() =>
                {
                    c.SyncStart();
                    return Ok();
                });
            case ["sync", "stop"]:
                return Run(() =>
                {
                    c.SyncStop();
                    return Ok();
                });
            case ["sync", "disarm"]:
                return Run(() =>
                {
                    c.SyncDisarm();
                    return Ok();
                });
            case ["sync", "count"]:
                return Run(() => Ok($"clocks={c.SyncCount()}"));
            case ["reset"]:
                return Run(() =>
                {
                    c.Reset();
                    return Ok();
                });
            case ["bootsel"]:
                return Run(() =>
                {
                    c.Bootsel();
                    return Ok();
                });
            default:
                return null;
        }
    }

    private static EdgeMode? ParseEdge(string s) => s switch
    {
        "rising" => EdgeMode.Rising,
        "falling" => EdgeMode.Falling,
        "both" => EdgeMode.Both,
        _ => null,
    };

    private static readonly string[] MapKeys =
        ["flags", "dir", "pu", "pd", "def", "opol", "ipol", "edge"];

    private static TypedOutcome? MapSet(Connection c, string[] kv)
    {
        var values = new Dictionary<string, uint>();
        foreach (var token in kv)
        {
            var eq = token.IndexOf('=');
            if (eq <= 0 || !Num(token[(eq + 1)..], out var v))
            {
                return null;
            }

            var key = token[..eq];
            if (key == "v")
            {
                if (v != Pins.ProtoVersion)
                {
                    return null;
                }

                continue;
            }

            if (!MapKeys.Contains(key) || !values.TryAdd(key, v))
            {
                return null;
            }
        }

        if (values.Count != MapKeys.Length || values["flags"] > byte.MaxValue)
        {
            return null;
        }

        var map = new PinMap(
            (byte)values["flags"], values["dir"], values["pu"], values["pd"], values["def"],
            values["opol"], values["ipol"], values["edge"]);
        return Run(() =>
        {
            c.MapSet(map);
            return Ok();
        });
    }

    private static TypedOutcome? PatternAdd(Connection c, string[] tokens)
    {
        var steps = new List<PatternStep>();
        foreach (var token in tokens)
        {
            var colon = token.IndexOf(':');
            if (colon <= 0 || !Num(token[..colon], out var bits)
                || !Num(token[(colon + 1)..], out var ticks))
            {
                return null;
            }

            steps.Add(new PatternStep(bits, ticks));
        }

        return Run(() => Ok($"total={c.PatternAdd(steps)}"));
    }
}
