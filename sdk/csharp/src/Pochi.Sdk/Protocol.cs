using System.Buffers.Binary;
using System.Globalization;
using System.Text.RegularExpressions;

namespace Pochi.Sdk;

/// <summary>Response line kind: OK / ERR / push (<c>! ...</c>).</summary>
public enum ResponseKind
{
    Ok,
    Err,
    Push,
}

/// <summary>A single response line, classified.</summary>
public readonly record struct Response(ResponseKind Kind, string Data)
{
    /// <summary>Extract the data of an OK response, mapping ERR codes to
    /// typed errors. A push line here is a routing bug (parse error).</summary>
    public string OkData() => Kind switch
    {
        ResponseKind.Ok => Data,
        ResponseKind.Err => throw SdkException.FromDeviceError(Data),
        _ => throw new SdkException(
            ErrorCode.Parse, $"unexpected push event in response position: ! {Data}"),
    };
}

/// <summary>Command builders and typed response parsers for the CDC text
/// protocol. Pure functions (no I/O) — every parser is unit-testable
/// without a device. Mirrors <c>sdk/rust/src/protocol.rs</c>.</summary>
public static partial class Protocol
{
    [GeneratedRegex(@"^v\d+\.\d+\.\d+$")]
    private static partial Regex VersionRegex();

    /// <summary>Classify one response line. Trailing CR/LF is tolerated.</summary>
    public static Response ParseResponse(string line)
    {
        var trimmed = line.TrimEnd('\r', '\n');
        if (trimmed == "OK")
        {
            return new Response(ResponseKind.Ok, "");
        }

        if (trimmed.StartsWith("OK ", StringComparison.Ordinal))
        {
            return new Response(ResponseKind.Ok, trimmed[3..]);
        }

        if (trimmed.StartsWith("ERR ", StringComparison.Ordinal))
        {
            return new Response(ResponseKind.Err, trimmed[4..]);
        }

        if (trimmed.StartsWith("! ", StringComparison.Ordinal))
        {
            return new Response(ResponseKind.Push, trimmed[2..]);
        }

        throw new SdkException(ErrorCode.Parse, $"unexpected response line: {trimmed}");
    }

    /// <summary>Extract <c>count=N</c> from an OK data string (ts get / sync count).</summary>
    public static ulong ParseCountField(string okData)
    {
        foreach (var part in SplitWhitespace(okData))
        {
            if (part.StartsWith("count=", StringComparison.Ordinal))
            {
                if (!TryParseDigits(part[6..], out ulong value))
                {
                    throw new SdkException(ErrorCode.Parse, $"invalid count= value: {okData}");
                }

                return value;
            }
        }

        throw new SdkException(ErrorCode.Parse, $"missing count= field: {okData}");
    }

    /// <summary>
    /// Extract <c>count=N overflow=B</c> from a <c>ts get</c> OK data string.
    /// <c>overflow=B</c> was added in FW v0.1.2 (Pochi-DIO
    /// <c>fix/cdc-tx-buffer-truncation</c>) and signals that the ring buffer
    /// overflowed since the last <c>ts get</c> (read-then-clear on the FW
    /// side). A missing <c>overflow=</c> (older FW) is treated as
    /// <c>overflow=0</c>.
    /// </summary>
    public static (ulong Count, bool Overflow) ParseCountOverflowField(string okData)
    {
        var count = ParseCountField(okData);
        foreach (var part in SplitWhitespace(okData))
        {
            if (part.StartsWith("overflow=", StringComparison.Ordinal))
            {
                var value = part["overflow=".Length..];
                if (value == "0")
                {
                    return (count, false);
                }

                if (value == "1")
                {
                    return (count, true);
                }

                throw new SdkException(ErrorCode.Parse, $"invalid overflow= value: {value}");
            }
        }

        return (count, false);
    }

    // --- low-level field helpers ---

    private static string[] SplitWhitespace(string s) =>
        s.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);

    private static bool TryParseDigits(string s, out ulong value) =>
        ulong.TryParse(s, NumberStyles.None, CultureInfo.InvariantCulture, out value);

    internal static uint ParseU32(string s)
    {
        if (s.StartsWith("0x", StringComparison.Ordinal)
            || s.StartsWith("0X", StringComparison.Ordinal))
        {
            var hex = s[2..];
            if (hex.Length > 0
                && ulong.TryParse(hex, NumberStyles.HexNumber, CultureInfo.InvariantCulture,
                    out var fromHex)
                && fromHex <= 0xFFFFFFFF)
            {
                return (uint)fromHex;
            }

            throw new SdkException(ErrorCode.Parse, $"invalid number: {s}");
        }

        if (TryParseDigits(s, out var fromDec) && fromDec <= 0xFFFFFFFF)
        {
            return (uint)fromDec;
        }

        throw new SdkException(ErrorCode.Parse, $"invalid number: {s}");
    }

    private static Dictionary<string, string> Fields(string data)
    {
        var result = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var part in SplitWhitespace(data))
        {
            var idx = part.IndexOf('=');
            if (idx > 0)
            {
                result[part[..idx]] = part[(idx + 1)..];
            }
        }

        return result;
    }

    private static string Require(Dictionary<string, string> fields, string key, string ctx)
    {
        if (!fields.TryGetValue(key, out var value))
        {
            throw new SdkException(ErrorCode.Parse, $"missing {key}= field in {ctx}");
        }

        return value;
    }

    private static SdkException InvalidNumber(string ctx, string s) =>
        new(ErrorCode.Parse, $"invalid number in {ctx}: {s}");

    private static byte ByteStrict(string s, string ctx) =>
        byte.TryParse(s, NumberStyles.None, CultureInfo.InvariantCulture, out var v)
            ? v
            : throw InvalidNumber(ctx, s);

    private static ushort UShortStrict(string s, string ctx) =>
        ushort.TryParse(s, NumberStyles.None, CultureInfo.InvariantCulture, out var v)
            ? v
            : throw InvalidNumber(ctx, s);

    private static uint UIntStrict(string s, string ctx) =>
        uint.TryParse(s, NumberStyles.None, CultureInfo.InvariantCulture, out var v)
            ? v
            : throw InvalidNumber(ctx, s);

    private static byte U8FromU32(string s, string ctx)
    {
        var value = ParseU32(s);
        return value <= 0xFF ? (byte)value : throw InvalidNumber(ctx, s);
    }

    // --- version ---

    /// <summary>Parse <c>v0.1.0 proto=1</c>.</summary>
    public static VersionInfo ParseVersion(string data)
    {
        var match = SplitWhitespace(data).FirstOrDefault(p => VersionRegex().IsMatch(p));
        if (match is null)
        {
            throw new SdkException(ErrorCode.Parse, $"missing version in: {data}");
        }

        var numbers = match[1..].Split('.');
        var fields = Fields(data);
        if (!fields.TryGetValue("proto", out var proto))
        {
            throw new SdkException(ErrorCode.Parse, $"missing proto= in: {data}");
        }

        var ctx = $"version: {data}";
        return new VersionInfo(
            Major: ByteStrict(numbers[0], ctx),
            Minor: ByteStrict(numbers[1], ctx),
            Patch: ByteStrict(numbers[2], ctx),
            ProtocolVersion: ByteStrict(proto, "version")
        );
    }

    // --- caps ---

    /// <summary>Parse <c>dio=23 out=12 in=11 ts_res=40ns pattern=256 ring=256
    /// feat=0x...</c>. Old firmware (<c>ts_res=1000</c>) fails loudly.</summary>
    public static Capabilities ParseCaps(string data)
    {
        var f = Fields(data);
        var ctx = $"caps: {data}";
        var tsResRaw = Require(f, "ts_res", ctx);
        if (tsResRaw.EndsWith("ns", StringComparison.Ordinal))
        {
            tsResRaw = tsResRaw[..^2];
        }

        var tsRes = UIntStrict(tsResRaw, ctx);
        var caps = new Capabilities(
            ProtocolVersion: 0, // populated by the caller from `version`
            MaxDio: ByteStrict(Require(f, "dio", ctx), ctx),
            OutCount: ByteStrict(Require(f, "out", ctx), ctx),
            InCount: ByteStrict(Require(f, "in", ctx), ctx),
            TsResolutionNs: tsRes,
            MaxPatternSteps: UShortStrict(Require(f, "pattern", ctx), ctx),
            TsRingEvents: UShortStrict(Require(f, "ring", ctx), ctx),
            Features: ParseU32(Require(f, "feat", ctx))
        );
        if (caps.TsResolutionNs == 1000)
        {
            throw SdkException.UnsupportedFirmware(
                "caps reports ts_res=1000ns (pre-Phase 9.6 timestamp format)");
        }

        return caps;
    }

    // --- info ---

    /// <summary>Parse <c>uid=AABBCCDD11223344 devnum=42</c>. devnum 255 maps to null.</summary>
    public static (string Uid, byte? DeviceNumber) ParseInfo(string data)
    {
        var f = Fields(data);
        var uid = f.GetValueOrDefault("uid", "");
        if (uid.Length == 0)
        {
            throw new SdkException(ErrorCode.Parse, $"missing uid in info response: {data}");
        }

        byte? deviceNumber = null;
        if (f.TryGetValue("devnum", out var devnum))
        {
            var n = ByteStrict(devnum, $"info: {data}");
            deviceNumber = n == 255 ? null : n;
        }

        return (uid, deviceNumber);
    }

    // --- map ---

    /// <summary>Parse <c>v=1 out=0:12 in=12:11 pull=up flags=0x01</c>.</summary>
    public static PinMap ParseMap(string data)
    {
        var f = Fields(data);
        var ctx = $"map: {data}";

        (byte Base, byte Count) ParseRange(string key)
        {
            var value = Require(f, key, ctx);
            var idx = value.IndexOf(':');
            if (idx < 0)
            {
                throw new SdkException(ErrorCode.Parse, $"invalid {key}= range in {ctx}");
            }

            return (ByteStrict(value[..idx], ctx), ByteStrict(value[(idx + 1)..], ctx));
        }

        var (outBase, outCount) = ParseRange("out");
        var (inBase, inCount) = ParseRange("in");
        var pull = Require(f, "pull", ctx) switch
        {
            "none" => PullMode.None,
            "up" => PullMode.Up,
            "down" => PullMode.Down,
            var other => throw new SdkException(
                ErrorCode.Parse, $"invalid pull mode in map: {other}"),
        };
        return new PinMap(
            Version: ByteStrict(Require(f, "v", ctx), ctx),
            OutBase: outBase,
            OutCount: outCount,
            InBase: inBase,
            InCount: inCount,
            Pull: pull,
            Flags: U8FromU32(Require(f, "flags", ctx), ctx)
        );
    }

    /// <summary>Encode a PinMap as the 48-char hex string for <c>map set</c>.
    /// Extended fields not in PinMap (out_default, polarities) are zero.</summary>
    public static string MapToHex(PinMap pinMap)
    {
        var buf = new byte[24];
        buf[0] = pinMap.Version;
        buf[1] = pinMap.OutBase;
        buf[2] = pinMap.OutCount;
        buf[3] = pinMap.InBase;
        buf[4] = pinMap.InCount;
        buf[5] = pinMap.Pull switch
        {
            PullMode.None => 0,
            PullMode.Up => 1,
            PullMode.Down => 2,
            var other => throw new SdkException(
                ErrorCode.Parse, $"invalid pull mode: {other}"),
        };
        buf[6] = pinMap.Flags;
        return Convert.ToHexString(buf).ToLowerInvariant();
    }

    // --- read / write / state ---

    /// <summary>Parse the <c>read</c> response data: <c>0x000005</c>.</summary>
    public static uint ParseRead(string data) => ParseU32(data.Trim());

    /// <summary>Parse <c>in=0x000005 out=0x00000A flags=0x00</c>.</summary>
    public static IoState ParseState(string data)
    {
        var f = Fields(data);
        var ctx = $"state: {data}";
        return new IoState(
            Inputs: ParseU32(Require(f, "in", ctx)),
            Outputs: ParseU32(Require(f, "out", ctx)),
            Flags: U8FromU32(Require(f, "flags", ctx), ctx)
        );
    }

    // --- pattern ---

    /// <summary>Encode pattern steps for <c>pattern load</c>: step count (u16 LE)
    /// followed by 8 bytes per step (out_bits u32 LE + hold_us u32 LE).</summary>
    public static string PatternToHex(IReadOnlyList<PatternStep> steps)
    {
        if (steps.Count == 0)
        {
            throw new SdkException(ErrorCode.Parse, "pattern must have at least one step");
        }

        if (steps.Count > 0xFFFF)
        {
            throw new SdkException(ErrorCode.Parse, $"too many pattern steps: {steps.Count}");
        }

        var data = new byte[2 + steps.Count * 8];
        BinaryPrimitives.WriteUInt16LittleEndian(data.AsSpan(0, 2), (ushort)steps.Count);
        for (var i = 0; i < steps.Count; i++)
        {
            BinaryPrimitives.WriteUInt32LittleEndian(data.AsSpan(2 + i * 8, 4), steps[i].OutBits);
            BinaryPrimitives.WriteUInt32LittleEndian(data.AsSpan(6 + i * 8, 4), steps[i].HoldUs);
        }

        return Convert.ToHexString(data).ToLowerInvariant();
    }

    /// <summary>Parse <c>accepted=4</c> from the <c>pattern load</c> response.</summary>
    public static ushort ParseAccepted(string data)
    {
        foreach (var part in SplitWhitespace(data))
        {
            if (part.StartsWith("accepted=", StringComparison.Ordinal))
            {
                return UShortStrict(part[9..], $"accepted: {data}");
            }
        }

        throw new SdkException(ErrorCode.Parse, $"missing accepted= field: {data}");
    }

    /// <summary>Build the <c>pattern run</c> command string.</summary>
    public static string PatternRunCommand(PatternMode mode, ushort repeat) =>
        mode == PatternMode.Once ? "pattern run once 1" : $"pattern run loop {repeat}";

    /// <summary>Parse <c>state=running step=5 loops=3</c>.</summary>
    public static PatternStatus ParsePatternStatus(string data)
    {
        var f = Fields(data);
        var ctx = $"pattern status: {data}";
        var state = Require(f, "state", ctx) switch
        {
            "idle" => PatternState.Idle,
            "loaded" => PatternState.Loaded,
            "running" => PatternState.Running,
            "done" => PatternState.Done,
            var other => throw new SdkException(
                ErrorCode.Parse, $"unknown pattern state: {other}"),
        };
        return new PatternStatus(
            State: state,
            CurrentStep: UShortStrict(Require(f, "step", ctx), ctx),
            LoopsDone: UShortStrict(Require(f, "loops", ctx), ctx)
        );
    }

    // --- timestamp ---

    /// <summary>Build the <c>ts arm</c> command string.</summary>
    public static string TsArmCommand(uint mask, EdgeMode mode)
    {
        var modeStr = mode switch
        {
            EdgeMode.Rising => "rising",
            EdgeMode.Falling => "falling",
            EdgeMode.Both => "both",
            var other => throw new SdkException(
                ErrorCode.Parse, $"invalid edge mode: {other}"),
        };
        return $"ts arm 0x{mask:x} {modeStr}";
    }

    /// <summary>Parse one <c>ts get</c> event line (FW Phase 9.6):
    /// <c>0x00000005 c=1000 p=7 s=1</c>. The pre-9.6 <c>t=</c> format is
    /// rejected as UnsupportedFirmware — never parsed silently.</summary>
    public static TimestampEvent ParseTsEventLine(string line)
    {
        var trimmed = line.Trim();
        var f = Fields(trimmed);
        var inputsPart = SplitWhitespace(trimmed).FirstOrDefault(p =>
            p.StartsWith("0x", StringComparison.Ordinal)
            || p.StartsWith("0X", StringComparison.Ordinal));

        if (f.ContainsKey("t") && !f.ContainsKey("c"))
        {
            throw SdkException.UnsupportedFirmware(
                $"ts event uses pre-Phase 9.6 `t=` format: {trimmed}");
        }

        if (inputsPart is null)
        {
            throw new SdkException(
                ErrorCode.Parse, $"missing inputs (0x...) field in ts event: {trimmed}");
        }

        var ctx = $"ts event: {trimmed}";
        var rawCount = UIntStrict(Require(f, "c", ctx), ctx);
        var rawPhase = ByteStrict(Require(f, "p", ctx), ctx);
        var s = Require(f, "s", ctx);
        if (s is not ("0" or "1"))
        {
            throw new SdkException(ErrorCode.Parse, $"invalid s= in ts event: {s}");
        }

        return new TimestampEvent(
            Inputs: ParseU32(inputsPart),
            RawCount: rawCount,
            RawPhase: rawPhase,
            SyncActive: s == "1",
            TimestampNs: Reconciler.AsIsNs(rawCount, rawPhase)
        );
    }

    // --- sync ---

    /// <summary>Parse the <c>sync count</c> response data: <c>count=1000000</c>.</summary>
    public static ulong ParseSyncCount(string data) => ParseCountField(data);

    // --- push events ---

    /// <summary>Parse the payload of a push line (after <c>! </c>). Unknown
    /// event types are preserved as UnknownEvent rather than dropped.</summary>
    public static PushEvent ParsePushEvent(string payload)
    {
        var trimmed = payload.Trim();
        var idx = trimmed.IndexOf(' ');
        var kind = idx < 0 ? trimmed : trimmed[..idx];
        var rest = idx < 0 ? "" : trimmed[(idx + 1)..];
        var f = Fields(rest);

        switch (kind)
        {
            case "INPUT":
                {
                    var inputsPart = SplitWhitespace(rest).FirstOrDefault(p =>
                        p.StartsWith("0x", StringComparison.Ordinal)
                        || p.StartsWith("0X", StringComparison.Ordinal));
                    if (inputsPart is null)
                    {
                        throw new SdkException(
                            ErrorCode.Parse, $"missing inputs (0x...) in INPUT event: {trimmed}");
                    }

                    if (!f.TryGetValue("t", out var t) || !TryParseDigits(t, out ulong timestampUs))
                    {
                        throw new SdkException(
                            ErrorCode.Parse, $"missing or invalid t= in INPUT event: {trimmed}");
                    }

                    return new InputChangeEvent(ParseU32(inputsPart), timestampUs);
                }

            case "PATTERN_DONE":
                {
                    if (!f.TryGetValue("loops", out var loops)
                        || !ushort.TryParse(loops, NumberStyles.None, CultureInfo.InvariantCulture,
                            out var loopCount))
                    {
                        throw new SdkException(
                            ErrorCode.Parse,
                            $"missing or invalid loops= in PATTERN_DONE event: {trimmed}");
                    }

                    return new PatternDoneEvent(loopCount);
                }

            case "SYNC_DONE":
                {
                    if (!f.TryGetValue("status", out var status)
                        || !f.TryGetValue("devnum", out var devnumStr)
                        || !byte.TryParse(devnumStr, NumberStyles.None, CultureInfo.InvariantCulture,
                            out var devnum)
                        || !f.TryGetValue("ts", out var tsStr)
                        || !TryParseDigits(tsStr, out ulong timestamp))
                    {
                        throw new SdkException(
                            ErrorCode.Parse, $"missing field in SYNC_DONE event: {trimmed}");
                    }

                    return new SyncDoneEvent(status, devnum, timestamp);
                }

            default:
                return new UnknownEvent(trimmed);
        }
    }
}
