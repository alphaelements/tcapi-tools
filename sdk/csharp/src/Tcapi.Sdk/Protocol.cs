using System.Globalization;
using System.Text;

namespace Tcapi.Sdk;

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

/// <summary>Command builders and typed response parsers for the v2 CDC text
/// protocol. Pure functions (no I/O): every parser is unit-testable without a
/// device. Mirrors <c>sdk/rust/src/protocol.rs</c>.
///
/// Parsers are strict: a response must carry exactly the documented keys, no
/// more and no fewer, and numbers must be in range. Anything else is a
/// <see cref="ErrorCode.Parse"/> error, never a silently defaulted value.</summary>
public static class Protocol
{
    /// <summary>Longest request line the device accepts, excluding the CR/LF
    /// terminator.</summary>
    public const int MaxLineBytes = 256;

    /// <summary>Largest <c>max</c> argument of <c>ts get</c>: one response is
    /// limited by the device line buffer.</summary>
    public const int MaxTsGetEvents = 85;

    /// <summary>Highest valid <c>p=</c> (raw phase) value of a timestamp event.</summary>
    private const byte MaxRawPhase = 24;

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

    /// <summary>Extract <c>count=N</c> from the header of a counted multi-line
    /// response (<c>ts get</c>, <c>help</c>).</summary>
    public static ulong ParseCountField(string okData) =>
        TryParseCountField(okData)
        ?? throw new SdkException(ErrorCode.Parse, $"missing count= field: {okData}");

    /// <summary>Like <see cref="ParseCountField"/> but returns null when the
    /// header has no <c>count=</c> token (a single-line response). A token
    /// that is present but not a number is still an error.</summary>
    public static ulong? TryParseCountField(string okData)
    {
        foreach (var part in SplitWhitespace(okData))
        {
            if (!part.StartsWith("count=", StringComparison.Ordinal))
            {
                continue;
            }

            return ulong.TryParse(
                part["count=".Length..], NumberStyles.None, CultureInfo.InvariantCulture,
                out var value)
                ? value
                : throw new SdkException(ErrorCode.Parse, $"invalid count= value: {okData}");
        }

        return null;
    }

    // --- key=value field parsing ---

    private static string[] SplitWhitespace(string s) =>
        s.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);

    private static bool IsAsciiDigits(string s)
    {
        if (s.Length == 0)
        {
            return false;
        }

        foreach (var c in s)
        {
            if (c is < '0' or > '9')
            {
                return false;
            }
        }

        return true;
    }

    private static bool IsHexDigits(string s)
    {
        if (s.Length == 0)
        {
            return false;
        }

        foreach (var c in s)
        {
            if (!(c is >= '0' and <= '9' or >= 'a' and <= 'f' or >= 'A' and <= 'F'))
            {
                return false;
            }
        }

        return true;
    }

    /// <summary>Parse a number given as decimal or <c>0x</c> hex. Digits
    /// only: no sign, no whitespace, no empty digit string.</summary>
    internal static uint ParseU32(string s) =>
        TryParseU32(s) is { } value
            ? value
            : throw new SdkException(
                ErrorCode.Parse,
                s.StartsWith("0x", StringComparison.OrdinalIgnoreCase)
                    ? $"invalid hex number: {s}"
                    : $"invalid number: {s}");

    /// <summary>Like <see cref="ParseU32"/>, but null for text that is not a
    /// number in range.</summary>
    internal static uint? TryParseU32(string s)
    {
        if (s.StartsWith("0x", StringComparison.Ordinal)
            || s.StartsWith("0X", StringComparison.Ordinal))
        {
            var hex = s[2..];
            return IsHexDigits(hex)
                && ulong.TryParse(hex.TrimStart('0').PadLeft(1, '0'), NumberStyles.HexNumber,
                    CultureInfo.InvariantCulture, out var fromHex)
                && fromHex <= uint.MaxValue
                    ? (uint)fromHex
                    : null;
        }

        return IsAsciiDigits(s)
            && ulong.TryParse(s, NumberStyles.None, CultureInfo.InvariantCulture, out var fromDec)
            && fromDec <= uint.MaxValue
                ? (uint)fromDec
                : null;
    }

    /// <summary>The <c>key=value</c> fields of one response, checked against
    /// the exact key set the protocol documents for it.</summary>
    private sealed class FieldSet
    {
        private readonly string _ctx;
        private readonly string _data;
        private readonly Dictionary<string, string> _pairs = new(StringComparer.Ordinal);

        /// <summary>Split <paramref name="data"/> into <c>key=value</c> tokens.
        /// Every key in <paramref name="keys"/> must be present exactly once
        /// and no other key may appear (order is free).</summary>
        public FieldSet(string ctx, string data, params string[] keys)
        {
            _ctx = ctx;
            _data = data;
            foreach (var token in SplitWhitespace(data))
            {
                var idx = token.IndexOf('=');
                if (idx < 0)
                {
                    throw Err($"token without '=' ({token})");
                }

                var key = token[..idx];
                if (!keys.Contains(key))
                {
                    throw Err($"unexpected key {key}=");
                }

                if (!_pairs.TryAdd(key, token[(idx + 1)..]))
                {
                    throw Err($"duplicate key {key}=");
                }
            }

            foreach (var key in keys)
            {
                if (!_pairs.ContainsKey(key))
                {
                    throw Err($"missing {key}= field");
                }
            }
        }

        private SdkException Err(string message) =>
            new(ErrorCode.Parse, $"{message} in {_ctx}: {_data}");

        public string Raw(string key) => _pairs[key];

        public SdkException InvalidValue(string key) =>
            new(ErrorCode.Parse, $"invalid {key}= value in {_ctx}: {_data}");

        private ulong Dec(string key, ulong max)
        {
            var raw = _pairs[key];
            if (!IsAsciiDigits(raw)
                || !ulong.TryParse(raw, NumberStyles.None, CultureInfo.InvariantCulture, out var v)
                || v > max)
            {
                throw InvalidValue(key);
            }

            return v;
        }

        public byte Dec8(string key) => (byte)Dec(key, byte.MaxValue);

        public ushort Dec16(string key) => (ushort)Dec(key, ushort.MaxValue);

        public uint Dec32(string key) => (uint)Dec(key, uint.MaxValue);

        public ulong Dec64(string key) => Dec(key, ulong.MaxValue);

        /// <summary>Mask or bit value: <c>0x</c> hex (canonical) or decimal.</summary>
        public uint Mask(string key)
        {
            try
            {
                return ParseU32(_pairs[key]);
            }
            catch (SdkException)
            {
                throw InvalidValue(key);
            }
        }

        public byte Mask8(string key)
        {
            var value = Mask(key);
            return value <= byte.MaxValue ? (byte)value : throw InvalidValue(key);
        }

        /// <summary><c>0</c> or <c>1</c>.</summary>
        public bool Flag(string key) => _pairs[key] switch
        {
            "0" => false,
            "1" => true,
            _ => throw InvalidValue(key),
        };
    }

    // --- request line checks ---

    /// <summary>Reject a request line that cannot be sent as exactly one
    /// command: a blank line (the device ignores it and never answers),
    /// embedded CR/LF (would be two commands) or more than
    /// <see cref="MaxLineBytes"/> bytes (the device would answer
    /// <c>LINE_TOO_LONG</c>).</summary>
    public static void CheckRequestLine(string line)
    {
        if (string.IsNullOrWhiteSpace(line))
        {
            throw new SdkException(
                ErrorCode.InvalidArgument, "command line must not be empty");
        }

        if (line.AsSpan().IndexOfAny('\r', '\n') >= 0)
        {
            throw new SdkException(
                ErrorCode.InvalidArgument, "command line must not contain CR or LF");
        }

        var bytes = Encoding.UTF8.GetByteCount(line);
        if (bytes > MaxLineBytes)
        {
            throw new SdkException(
                ErrorCode.InvalidArgument,
                $"command line is {bytes} bytes, the limit is {MaxLineBytes}");
        }
    }

    // --- version ---

    /// <summary>Parse <c>fw=0.1.3 proto=2</c>. The protocol number is returned
    /// as reported; the caller decides whether it is supported.</summary>
    public static VersionInfo ParseVersion(string data)
    {
        var f = new FieldSet("version", data, "fw", "proto");
        var fw = f.Raw("fw");
        var nums = fw.Split('.');
        SdkException Bad() => new(ErrorCode.Parse, $"invalid fw= value in version: {data}");
        byte Part(string s) =>
            IsAsciiDigits(s) && byte.TryParse(s, NumberStyles.None, CultureInfo.InvariantCulture, out var v)
                ? v
                : throw Bad();
        if (nums.Length != 3)
        {
            throw Bad();
        }

        return new VersionInfo(
            Major: Part(nums[0]),
            Minor: Part(nums[1]),
            Patch: Part(nums[2]),
            ProtocolVersion: f.Dec8("proto"));
    }

    // --- caps ---

    /// <summary>Parse <c>dio=25 out=2 in=23 ts_res_ns=40 tick_ns=200
    /// pattern=256 ring=256 feat=0x00000003</c>.</summary>
    public static Capabilities ParseCaps(string data)
    {
        var f = new FieldSet(
            "caps", data, "dio", "out", "in", "ts_res_ns", "tick_ns", "pattern", "ring", "feat");
        return new Capabilities(
            Dio: f.Dec8("dio"),
            Out: f.Dec8("out"),
            In: f.Dec8("in"),
            TsResNs: f.Dec32("ts_res_ns"),
            TickNs: f.Dec32("tick_ns"),
            PatternMax: f.Dec16("pattern"),
            Ring: f.Dec16("ring"),
            Features: f.Mask("feat"));
    }

    // --- info / devnum / ping ---

    /// <summary>Parse <c>uid=0123456789ABCDEF devnum=42</c>. devnum 255
    /// (unassigned) maps to null.</summary>
    public static (string Uid, byte? DeviceNumber) ParseInfo(string data)
    {
        var f = new FieldSet("info", data, "uid", "devnum");
        var uid = f.Raw("uid");
        if (uid.Length != 16 || !IsHexDigits(uid))
        {
            throw new SdkException(ErrorCode.Parse, $"invalid uid= value in info: {data}");
        }

        var devnum = f.Dec8("devnum");
        return (uid, devnum == 255 ? null : devnum);
    }

    /// <summary>Build the <c>devnum &lt;n&gt;</c> command (255 unassigns).</summary>
    public static string DevnumCommand(byte n) =>
        string.Create(CultureInfo.InvariantCulture, $"devnum {n}");

    /// <summary>Build the <c>ping &lt;value&gt;</c> command.</summary>
    public static string PingCommand(uint value) =>
        string.Create(CultureInfo.InvariantCulture, $"ping {value}");

    /// <summary>Parse the <c>ping</c> response <c>pong=&lt;u32&gt;</c>.</summary>
    public static uint ParsePong(string data) => new FieldSet("ping", data, "pong").Dec32("pong");

    // --- map ---

    /// <summary>Parse the <c>map get</c> response <c>v=2 flags=0x00 dir=...
    /// edge=...</c> and validate it: a device reporting an invalid or non-v2
    /// map is an error, not a value.</summary>
    public static PinMap ParseMap(string data)
    {
        var f = new FieldSet(
            "map", data, "v", "flags", "dir", "pu", "pd", "def", "opol", "ipol", "edge");
        var version = f.Dec8("v");
        if (version != Pins.ProtoVersion)
        {
            throw new SdkException(
                ErrorCode.Parse, $"unsupported map version v={version} in map: {data}");
        }

        var map = new PinMap(
            Flags: f.Mask8("flags"),
            Direction: f.Mask("dir"),
            PullUp: f.Mask("pu"),
            PullDown: f.Mask("pd"),
            OutDefault: f.Mask("def"),
            OutPolarity: f.Mask("opol"),
            InPolarity: f.Mask("ipol"),
            Edge: f.Mask("edge"));
        try
        {
            map.Validate();
        }
        catch (SdkException ex)
        {
            throw new SdkException(
                ErrorCode.Parse,
                $"device reported an invalid map ({ex.Message}): {data}",
                ex);
        }

        return map;
    }

    /// <summary>Build the <c>map set</c> command for <paramref name="map"/>
    /// (validated first).</summary>
    public static string MapSetCommand(PinMap map) => $"map set {map.ToSetArgs()}";

    // --- read / write / state ---

    /// <summary>Parse the <c>read</c> response <c>in=0x00000005</c>.</summary>
    public static uint ParseRead(string data) => new FieldSet("read", data, "in").Mask("in");

    /// <summary>Parse the <c>state</c> response <c>in=0x00000000 out=0x00000005</c>.</summary>
    public static IoState ParseState(string data)
    {
        var f = new FieldSet("state", data, "in", "out");
        return new IoState(Inputs: f.Mask("in"), Outputs: f.Mask("out"));
    }

    /// <summary>Build the <c>write &lt;values&gt; &lt;mask&gt;</c> command. The
    /// mask must stay within the DIO pins. Value bits outside the mask are
    /// ignored by the device (including bits that are not DIO pins), so they are
    /// not checked.</summary>
    public static string WriteCommand(uint values, uint mask)
    {
        Pins.CheckDioMask("write mask", mask);
        return $"write 0x{values:x} 0x{mask:x}";
    }

    // --- pattern ---

    /// <summary>Build the <c>pattern add</c> command lines for
    /// <paramref name="steps"/>. Steps are packed greedily so every line stays
    /// within <see cref="MaxLineBytes"/>; each line is applied atomically by the
    /// device. Every step is validated first, so nothing is produced for a bad
    /// pattern.</summary>
    public static IReadOnlyList<string> PatternAddCommands(IReadOnlyList<PatternStep> steps)
    {
        if (steps.Count == 0)
        {
            throw new SdkException(
                ErrorCode.InvalidArgument, "pattern must have at least one step");
        }

        const string prefix = "pattern add";
        var lines = new List<string>();
        var line = new StringBuilder(prefix);
        foreach (var step in steps)
        {
            var text = step.ToText();

            // +1 for the separating space.
            if (line.Length + 1 + text.Length > MaxLineBytes)
            {
                lines.Add(line.ToString());
                line.Clear().Append(prefix);
            }

            line.Append(' ').Append(text);
        }

        lines.Add(line.ToString());
        return lines;
    }

    /// <summary>Parse the <c>pattern add</c> response <c>total=&lt;n&gt;</c>:
    /// steps now in the buffer.</summary>
    public static ushort ParsePatternTotal(string data) =>
        new FieldSet("pattern add", data, "total").Dec16("total");

    /// <summary>Build the <c>pattern run</c> command: <c>pattern run once</c>
    /// (the repeat is ignored) or <c>pattern run loop &lt;repeat&gt;</c>
    /// (repeat 1-65535).</summary>
    public static string PatternRunCommand(PatternMode mode, ushort repeat) => mode switch
    {
        PatternMode.Once => "pattern run once",
        PatternMode.Loop when repeat >= 1 => $"pattern run loop {repeat}",
        PatternMode.Loop => throw new SdkException(
            ErrorCode.InvalidArgument, "pattern run loop requires a repeat of 1-65535"),
        _ => throw new SdkException(ErrorCode.InvalidArgument, $"invalid pattern mode: {mode}"),
    };

    /// <summary>Parse <c>state=running step=5 loops=3 total=40</c>.</summary>
    public static PatternStatus ParsePatternStatus(string data)
    {
        var f = new FieldSet("pattern status", data, "state", "step", "loops", "total");
        var state = f.Raw("state") switch
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
            Step: f.Dec16("step"),
            Loops: f.Dec16("loops"),
            Total: f.Dec16("total"));
    }

    // --- timestamp ---

    /// <summary>Build the <c>ts arm</c> command. The mask must be non-zero and
    /// stay within the DIO pins.</summary>
    public static string TsArmCommand(uint mask, EdgeMode mode)
    {
        Pins.CheckDioMask("ts arm mask", mask);
        if (mask == 0)
        {
            throw new SdkException(ErrorCode.InvalidArgument, "ts arm mask must not be 0");
        }

        var modeStr = mode switch
        {
            EdgeMode.Rising => "rising",
            EdgeMode.Falling => "falling",
            EdgeMode.Both => "both",
            _ => throw new SdkException(ErrorCode.InvalidArgument, $"invalid edge mode: {mode}"),
        };
        return $"ts arm 0x{mask:x} {modeStr}";
    }

    /// <summary>Build the <c>ts get &lt;max&gt;</c> command (max 1-85).</summary>
    public static string TsGetCommand(ushort max)
    {
        if (max is < 1 or > MaxTsGetEvents)
        {
            throw new SdkException(
                ErrorCode.InvalidArgument,
                $"ts get max {max} is outside 1-{MaxTsGetEvents}");
        }

        return string.Create(CultureInfo.InvariantCulture, $"ts get {max}");
    }

    /// <summary>Parse the <c>ts status</c> response
    /// <c>armed=1 pending=2 overflow=0</c>.</summary>
    public static TsStatus ParseTsStatus(string data)
    {
        var f = new FieldSet("ts status", data, "armed", "pending", "overflow");
        return new TsStatus(
            Armed: f.Flag("armed"), Pending: f.Dec32("pending"), Overflow: f.Flag("overflow"));
    }

    /// <summary>Parse the header of a <c>ts get</c> response,
    /// <c>count=3 overflow=0</c>: the number of event lines that follow and
    /// the ring-overflow flag.</summary>
    public static (uint Count, bool Overflow) ParseTsGetHeader(string data)
    {
        var f = new FieldSet("ts get", data, "count", "overflow");
        return (f.Dec32("count"), f.Flag("overflow"));
    }

    /// <summary>Parse one <c>ts get</c> event line
    /// <c>in=0x00000001 c=1000 p=7 s=1</c> (surrounding whitespace, including
    /// the two leading spaces of a continuation line, is ignored).</summary>
    public static TimestampEvent ParseTsEventLine(string line)
    {
        var trimmed = line.Trim();
        var f = new FieldSet("ts event", trimmed, "in", "c", "p", "s");
        var phase = f.Dec8("p");
        if (phase > MaxRawPhase)
        {
            throw new SdkException(
                ErrorCode.Parse, $"invalid p= value in ts event: {trimmed}");
        }

        return new TimestampEvent(
            Inputs: f.Mask("in"),
            RawCount: f.Dec32("c"),
            RawPhase: phase,
            SyncActive: f.Flag("s"));
    }

    // --- sync ---

    /// <summary>Parse the <c>sync count</c> response <c>clocks=1000000</c>
    /// (a single line, not a counted response).</summary>
    public static ulong ParseSyncCount(string data) =>
        new FieldSet("sync count", data, "clocks").Dec64("clocks");

    // --- safety functions ---

    /// <summary>Build the <c>wdog &lt;ms&gt;</c> command: 0 disables the
    /// watchdog, 100-10000 enables it. Any other value is refused before
    /// sending (the device would answer <c>BAD_PARAM</c>).</summary>
    public static string WdogCommand(uint ms)
    {
        if (ms != 0 && ms is < SafetyLimits.WdogMinMs or > SafetyLimits.WdogMaxMs)
        {
            throw new SdkException(
                ErrorCode.InvalidArgument,
                $"watchdog timeout {ms} ms must be 0 or between {SafetyLimits.WdogMinMs} "
                    + $"and {SafetyLimits.WdogMaxMs}");
        }

        return string.Create(CultureInfo.InvariantCulture, $"wdog {ms}");
    }

    /// <summary>Build the <c>usbsafe on|off</c> command.</summary>
    public static string UsbsafeCommand(bool on) => on ? "usbsafe on" : "usbsafe off";

    /// <summary>Build the <c>excl set &lt;mask&gt;...</c> command: 1 to 16 groups,
    /// each a subset of the DIO pins with at least 2 bits. That every pin is an
    /// <i>output</i> depends on the active map and is checked by the device.</summary>
    public static string ExclSetCommand(IReadOnlyList<uint> masks)
    {
        if (masks.Count is 0 or > SafetyLimits.MaxExclusiveGroups)
        {
            throw new SdkException(
                ErrorCode.InvalidArgument,
                $"excl set takes 1 to {SafetyLimits.MaxExclusiveGroups} groups, got {masks.Count}");
        }

        var line = new StringBuilder("excl set");
        for (var i = 0; i < masks.Count; i++)
        {
            var mask = masks[i];
            Pins.CheckDioMask($"exclusive group {i} mask", mask);
            if (uint.PopCount(mask) < 2)
            {
                throw new SdkException(
                    ErrorCode.InvalidArgument,
                    $"exclusive group {i} mask 0x{mask:x8} needs at least 2 pins");
            }

            line.Append(" 0x").Append(mask.ToString("x", CultureInfo.InvariantCulture));
        }

        return line.ToString();
    }

    /// <summary>Parse the <c>safety</c> response
    /// <c>wdog_ms=0 remaining_ms=0 failsafe=0 cause=none usbsafe=0 excl=0</c>.
    /// The latch and its cause must agree: <c>failsafe=1</c> has a cause other
    /// than <c>none</c>, <c>failsafe=0</c> has cause <c>none</c>.</summary>
    public static SafetyState ParseSafety(string data)
    {
        var f = new FieldSet(
            "safety", data, "wdog_ms", "remaining_ms", "failsafe", "cause", "usbsafe", "excl");
        var cause = f.Raw("cause") switch
        {
            "none" => FailsafeCause.None,
            "wdog" => FailsafeCause.Wdog,
            "usb" => FailsafeCause.Usb,
            _ => throw f.InvalidValue("cause"),
        };
        var failsafe = f.Flag("failsafe");
        if (failsafe == (cause == FailsafeCause.None))
        {
            throw new SdkException(
                ErrorCode.Parse, $"failsafe latch and cause disagree in safety: {data}");
        }

        var excl = f.Dec8("excl");
        return excl <= SafetyLimits.MaxExclusiveGroups
            ? new SafetyState(
                WdogMs: f.Dec32("wdog_ms"),
                RemainingMs: f.Dec32("remaining_ms"),
                Failsafe: failsafe,
                Cause: cause,
                UsbSafe: f.Flag("usbsafe"),
                Excl: excl)
            : throw f.InvalidValue("excl");
    }

    /// <summary>Parse the <c>rstinfo</c> response
    /// <c>cause=por uptime_ms=0 boot=0x00000001</c>.</summary>
    public static ResetInfo ParseRstinfo(string data)
    {
        var f = new FieldSet("rstinfo", data, "cause", "uptime_ms", "boot");
        var cause = f.Raw("cause") switch
        {
            "por" => ResetCause.Por,
            "wdt" => ResetCause.Wdt,
            "soft" => ResetCause.Soft,
            "bor" => ResetCause.Bor,
            "other" => ResetCause.Other,
            _ => throw f.InvalidValue("cause"),
        };
        return new ResetInfo(cause, f.Dec64("uptime_ms"), f.Mask("boot"));
    }

    /// <summary>Parse the <c>pads</c> response <c>out=0x00000005 pad=0x00000005</c>.</summary>
    public static Pads ParsePads(string data)
    {
        var f = new FieldSet("pads", data, "out", "pad");
        return new Pads(f.Mask("out"), f.Mask("pad"));
    }

    /// <summary>Parse the counted <c>excl get</c> response: the header
    /// <c>count=&lt;n&gt;</c> and <c>n</c> lines <c>  mask=0x%08x</c>, in the order
    /// the groups were set.</summary>
    public static IReadOnlyList<uint> ParseExclGet(string header, IReadOnlyList<string> lines)
    {
        var count = new FieldSet("excl get", header, "count").Dec64("count");
        if (count > SafetyLimits.MaxExclusiveGroups)
        {
            throw new SdkException(
                ErrorCode.Parse,
                $"excl get announced {count} groups, the device holds at most "
                    + $"{SafetyLimits.MaxExclusiveGroups}");
        }

        if (count != (ulong)lines.Count)
        {
            throw new SdkException(
                ErrorCode.Parse,
                $"excl get header announced {count} groups but {lines.Count} lines were read");
        }

        return lines
            .Select(line => new FieldSet("excl get line", line.Trim(), "mask").Mask("mask"))
            .ToArray();
    }

    // --- push events ---

    /// <summary>Parse the payload of a push line (after <c>! </c>). A
    /// recognised event with malformed fields, and an unknown event name, are
    /// both <see cref="ErrorCode.Parse"/> errors: the device sends exactly
    /// four events, anything else is logged and dropped by the transport.</summary>
    public static PushEvent ParsePushEvent(string payload)
    {
        var trimmed = payload.Trim();
        var idx = trimmed.IndexOf(' ');
        var kind = idx < 0 ? trimmed : trimmed[..idx];
        var rest = idx < 0 ? "" : trimmed[(idx + 1)..];

        switch (kind)
        {
            case "INPUT":
                {
                    var f = new FieldSet("INPUT event", rest, "in", "t");
                    return new InputChangeEvent(f.Mask("in"), f.Dec64("t"));
                }

            case "PATTERN_DONE":
                return new PatternDoneEvent(
                    new FieldSet("PATTERN_DONE event", rest, "loops").Dec16("loops"));

            case "PATTERN_TIMEOUT":
                return new PatternTimeoutEvent(
                    new FieldSet("PATTERN_TIMEOUT event", rest, "loops").Dec16("loops"));

            case "FAILSAFE":
                {
                    var f = new FieldSet("FAILSAFE event", rest, "cause");

                    // A trip always has a cause; `none` is only the idle `safety` value.
                    return f.Raw("cause") switch
                    {
                        "wdog" => new FailsafeEvent(FailsafeCause.Wdog),
                        "usb" => new FailsafeEvent(FailsafeCause.Usb),
                        _ => throw f.InvalidValue("cause"),
                    };
                }

            default:
                throw new SdkException(ErrorCode.Parse, $"unknown event: {trimmed}");
        }
    }
}
