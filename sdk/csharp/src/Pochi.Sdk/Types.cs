using System.Globalization;
using System.Text.Json.Serialization;

namespace Pochi.Sdk;

// v2 data types and the channel / pin convention (docs/sdk-api-design.md
// section 2, protocol-reference.md section 10). Mirrors the Rust reference
// implementation (sdk/rust/src/types.rs). Serialize via WireJson to get the
// snake_case wire format (docs/sdk-api-design.md section 6).

/// <summary>Protocol constants and the channel / pin helpers. Every bit mask
/// the SDK sends or returns is a <b>physical GP bit position</b>; logical
/// channels ch0-ch24 are a display concept. Applications convert with these
/// helpers and never re-implement the bit arithmetic.</summary>
public static class Pins
{
    /// <summary>The only protocol version this SDK speaks (<c>version</c>
    /// reports <c>proto=2</c>).</summary>
    public const byte ProtoVersion = 2;

    /// <summary>Number of DIO channels (ch0-ch24).</summary>
    public const byte DioChannels = 25;

    /// <summary>Bit mask of the DIO pins: GP0-GP22, GP26, GP27. GP23, GP24,
    /// GP25 and GP28 are not DIO and are always 0 in every mask.</summary>
    public const uint ValidDioMask = 0x0C7F_FFFF;

    /// <summary>Pattern tick: one <c>hold_ticks</c> unit in nanoseconds.</summary>
    public const uint PatternTickNs = 200;

    /// <summary>First channel that is relocated past the unusable GP23-GP25
    /// (ch23 is GP26).</summary>
    private const byte FirstRelocatedCh = 23;

    /// <summary>GP pin of the first relocated channel.</summary>
    private const byte FirstRelocatedGp = 26;

    /// <summary>Last GP pin that carries a DIO channel (ch24).</summary>
    private const byte LastDioGp = 27;

    /// <summary>Physical GP pin of logical channel <paramref name="ch"/>
    /// (ch0-ch22 are GP0-GP22, ch23 is GP26, ch24 is GP27).</summary>
    public static byte ChToGp(byte ch)
    {
        if (ch < FirstRelocatedCh)
        {
            return ch;
        }

        if (ch < DioChannels)
        {
            return (byte)(ch - FirstRelocatedCh + FirstRelocatedGp);
        }

        throw new SdkException(
            ErrorCode.InvalidArgument,
            $"channel ch{ch} is out of range (ch0-ch{DioChannels - 1})");
    }

    /// <summary>Logical channel of physical GP pin <paramref name="gp"/>;
    /// fails for non-DIO pins (GP23-GP25, GP28 and above).</summary>
    public static byte GpToCh(byte gp)
    {
        if (gp < FirstRelocatedCh)
        {
            return gp;
        }

        if (gp is >= FirstRelocatedGp and <= LastDioGp)
        {
            return (byte)(gp - FirstRelocatedGp + FirstRelocatedCh);
        }

        throw new SdkException(ErrorCode.InvalidArgument, $"GP{gp} is not a DIO pin");
    }

    /// <summary>Display label for physical GP pin <paramref name="gp"/>,
    /// e.g. <c>GP26 (ch23)</c>.</summary>
    public static string PinLabel(byte gp) =>
        string.Create(CultureInfo.InvariantCulture, $"GP{gp} (ch{GpToCh(gp)})");

    /// <summary>Reject a mask that has bits outside <see cref="ValidDioMask"/>.</summary>
    public static void CheckDioMask(string name, uint mask)
    {
        if ((mask & ~ValidDioMask) != 0)
        {
            throw new SdkException(
                ErrorCode.InvalidArgument,
                $"{name} 0x{mask:x8} has bits outside the DIO pins (0x{ValidDioMask:x8})");
        }
    }
}

public sealed record DeviceInfo(
    string Uid,
    byte? DeviceNumber,
    string Port,
    string? Version
);

public sealed record VersionInfo(
    byte Major,
    byte Minor,
    byte Patch,
    byte ProtocolVersion
);

/// <summary>The eight feature bits of the <c>caps</c> <c>feat</c> field. A
/// host sends a command only when its bit is set (an older firmware answers
/// <c>UNKNOWN_CMD</c>); the SDK does not check the bit before every call, so
/// applications that must support older firmware call
/// <see cref="Connection.Caps"/> first and test <see cref="Capabilities.Has"/>.
/// The numeric value of a member is its bit mask.</summary>
[Flags]
public enum Feature : uint
{
    /// <summary>Bit 0: multi-device clock sync (<c>sync</c> commands).</summary>
    Sync = 0x01,

    /// <summary>Bit 1: reset commands (<c>reset</c> / <c>bootsel</c> /
    /// <c>pattern reset</c>).</summary>
    Reset = 0x02,

    /// <summary>Bit 2: watchdog and failsafe (<c>wdog</c>, <c>safety</c>,
    /// <c>failsafe clear</c>, <c>! FAILSAFE</c>).</summary>
    Wdog = 0x04,

    /// <summary>Bit 3: exclusive output groups (<c>excl set|clear|get</c>).</summary>
    Excl = 0x08,

    /// <summary>Bit 4: <c>outputs reset</c>.</summary>
    OutReset = 0x10,

    /// <summary>Bit 5: <c>rstinfo</c>.</summary>
    RstInfo = 0x20,

    /// <summary>Bit 6: <c>usbsafe</c>.</summary>
    UsbSafe = 0x40,

    /// <summary>Bit 7: <c>pads</c>.</summary>
    Pads = 0x80,
}

/// <summary>The set of defined <see cref="Feature"/> bits.</summary>
public static class FeatureBits
{
    /// <summary>The mask of every defined bit (<c>0xff</c>).</summary>
    public const uint Mask = 0xff;

    /// <summary>Every defined feature, in bit order.</summary>
    public static IReadOnlyList<Feature> All { get; } =
    [
        Feature.Sync,
        Feature.Reset,
        Feature.Wdog,
        Feature.Excl,
        Feature.OutReset,
        Feature.RstInfo,
        Feature.UsbSafe,
        Feature.Pads,
    ];
}

/// <summary>Parsed <c>caps</c> response
/// (<c>dio= out= in= ts_res_ns= tick_ns= pattern= ring= feat=</c>).</summary>
/// <param name="Dio">Number of DIO pins (25).</param>
/// <param name="Out">Pins currently configured as outputs.</param>
/// <param name="In">Pins currently configured as inputs.</param>
/// <param name="TsResNs">Timestamp phase resolution in nanoseconds (40).</param>
/// <param name="TickNs">Pattern tick in nanoseconds (200).</param>
/// <param name="PatternMax">Maximum number of pattern steps (wire key <c>pattern</c>).</param>
/// <param name="Ring">Timestamp ring capacity in events.</param>
/// <param name="Features">Feature bit mask (wire key <c>feat</c>, see <see cref="Feature"/>).</param>
public sealed record Capabilities(
    byte Dio,
    byte Out,
    byte In,
    uint TsResNs,
    uint TickNs,
    ushort PatternMax,
    ushort Ring,
    uint Features
)
{
    /// <summary>True if bit 0 of <see cref="Features"/> (sync capability) is set.</summary>
    [JsonIgnore]
    public bool HasSync => Has(Feature.Sync);

    /// <summary>True if bit 1 of <see cref="Features"/> (reset commands) is set.</summary>
    [JsonIgnore]
    public bool HasReset => Has(Feature.Reset);

    /// <summary>True if the bit of <paramref name="feature"/> is set.</summary>
    public bool Has(Feature feature) => (Features & (uint)feature) != 0;

    /// <summary>The defined features whose bit is set, in bit order (undefined
    /// bits are ignored).</summary>
    public IReadOnlyList<Feature> FeatureList() => FeatureBits.All.Where(Has).ToArray();
}

/// <summary>Parsed <c>state</c> response: physical GP bits, logical levels.</summary>
public sealed record IoState(
    uint Inputs,
    uint Outputs
);

/// <summary>Limits of the safety functions (docs/sdk-api-design.md, "Safety
/// types").</summary>
public static class SafetyLimits
{
    /// <summary>Smallest enabled watchdog timeout in milliseconds (<c>0</c> disables it).</summary>
    public const uint WdogMinMs = 100;

    /// <summary>Largest watchdog timeout in milliseconds.</summary>
    public const uint WdogMaxMs = 10000;

    /// <summary>Largest number of exclusive groups.</summary>
    public const int MaxExclusiveGroups = 16;
}

/// <summary>Cause of the failsafe latch (wire: <c>none</c> | <c>wdog</c> | <c>usb</c>).</summary>
public enum FailsafeCause
{
    /// <summary>The latch is not set.</summary>
    None,

    /// <summary>The watchdog tripped.</summary>
    Wdog,

    /// <summary>The USB link was lost with <c>usbsafe on</c>.</summary>
    Usb,
}

/// <summary>Parsed <c>safety</c> response: the volatile safety state of the
/// device.</summary>
/// <param name="WdogMs">Configured watchdog timeout in milliseconds, 0 = disabled.</param>
/// <param name="RemainingMs">Time left, rounded up, read before this command
/// restarted the timer; 0 when disabled or latched.</param>
/// <param name="Failsafe">The failsafe latch.</param>
/// <param name="Cause">The cause of the latch (the first cause is kept);
/// <see cref="FailsafeCause.None"/> exactly when <paramref name="Failsafe"/> is false.</param>
/// <param name="UsbSafe">The <c>usbsafe</c> setting (wire key <c>usbsafe</c>).</param>
/// <param name="Excl">Number of exclusive groups, 0-16.</param>
public sealed record SafetyState(
    uint WdogMs,
    uint RemainingMs,
    bool Failsafe,
    FailsafeCause Cause,
    [property: JsonPropertyName("usbsafe")] bool UsbSafe,
    byte Excl
);

/// <summary>Cause of the last restart (<c>rstinfo cause=</c>).</summary>
public enum ResetCause
{
    /// <summary>Power-on.</summary>
    Por,

    /// <summary>Hardware watchdog.</summary>
    Wdt,

    /// <summary>Software reset (including the <c>reset</c> command).</summary>
    Soft,

    /// <summary>Brown-out.</summary>
    Bor,

    /// <summary>Anything else.</summary>
    Other,
}

/// <summary>Parsed <c>rstinfo</c> response: the cause and time of the last restart.</summary>
/// <param name="Cause">Why the device restarted.</param>
/// <param name="UptimeMs">Milliseconds since the restart.</param>
/// <param name="Boot">A value that differs at every restart; a changed value
/// tells the host the device restarted and its safety settings must be
/// re-applied.</param>
public sealed record ResetInfo(ResetCause Cause, ulong UptimeMs, uint Boot);

/// <summary>Parsed <c>pads</c> response: the recorded outputs and the level read
/// back from the pads of the output pins, both logical. A difference means
/// something outside the device drives the pin.</summary>
public sealed record Pads(uint Out, uint Pad);

/// <summary>The declared safety settings of a <c>safety.toml</c>: what the
/// device must look like after <see cref="Connection.ApplySafety"/>. The
/// all-off <see cref="Default"/> is the content of a file with only
/// <c>version = 2</c>. Groups compare by value, in order.</summary>
/// <param name="WatchdogMs"><c>watchdog.timeout_ms</c>: 0 = disabled, otherwise 100-10000.</param>
/// <param name="UsbSafe"><c>usb.safe</c>: <c>usbsafe on</c> when true (wire key <c>usbsafe</c>).</param>
/// <param name="Groups">One pin mask per <c>[[exclusive]]</c>, in file order (at
/// most 16, each a subset of the DIO pins with at least 2 bits).</param>
public sealed record SafetyConfig(
    uint WatchdogMs,
    [property: JsonPropertyName("usbsafe")] bool UsbSafe,
    IReadOnlyList<uint> Groups
)
{
    /// <summary>Everything off: no watchdog, no usbsafe, no groups.</summary>
    public static SafetyConfig Default { get; } = new(0, false, []);

    /// <summary>The commands that make the device equal to this configuration,
    /// in the DD-16 order (config-files.md section 7): <c>excl set &lt;masks&gt;</c>
    /// (or <c>excl clear</c> when there are no groups), <c>usbsafe on|off</c>,
    /// <c>wdog &lt;ms&gt;</c>. <c>excl set</c> replaces all groups atomically, so
    /// <c>excl clear</c> is sent only when there are no groups and never before
    /// an <c>excl set</c>; the watchdog goes last so it cannot trip while the
    /// rest is still being sent. A value the device would refuse is an
    /// <see cref="ErrorCode.InvalidArgument"/> and nothing is produced.</summary>
    public IReadOnlyList<string> Commands() =>
    [
        Groups.Count == 0 ? "excl clear" : Protocol.ExclSetCommand(Groups),
        Protocol.UsbsafeCommand(UsbSafe),
        Protocol.WdogCommand(WatchdogMs),
    ];

    public bool Equals(SafetyConfig? other) =>
        other is not null
        && WatchdogMs == other.WatchdogMs
        && UsbSafe == other.UsbSafe
        && Groups.SequenceEqual(other.Groups);

    public override int GetHashCode()
    {
        var hash = new HashCode();
        hash.Add(WatchdogMs);
        hash.Add(UsbSafe);
        foreach (var group in Groups)
        {
            hash.Add(group);
        }

        return hash.ToHashCode();
    }
}

/// <summary>The v2 pin map: eight fields, all masks physical GP bits. Parsed
/// from <c>map get</c> and sent with <c>map set</c>.</summary>
/// <param name="Flags">Reserved, must be 0.</param>
/// <param name="Direction">Key <c>dir</c>: 1 = output.</param>
/// <param name="PullUp">Key <c>pu</c>: pull-up (inputs only, exclusive with pull-down).</param>
/// <param name="PullDown">Key <c>pd</c>: pull-down (inputs only).</param>
/// <param name="OutDefault">Key <c>def</c>: initial output level (outputs only).</param>
/// <param name="OutPolarity">Key <c>opol</c>: output polarity inversion (outputs only).</param>
/// <param name="InPolarity">Key <c>ipol</c>: input polarity inversion (inputs only).</param>
/// <param name="Edge">Key <c>edge</c>: inputs that raise <c>! INPUT</c> events.</param>
public sealed record PinMap(
    byte Flags,
    uint Direction,
    uint PullUp,
    uint PullDown,
    uint OutDefault,
    uint OutPolarity,
    uint InPolarity,
    uint Edge
)
{
    /// <summary>The map applied at power-up without a saved map: every DIO
    /// pin an input with pull-down and edge events enabled.</summary>
    public static PinMap Default { get; } = new(
        Flags: 0,
        Direction: 0,
        PullUp: 0,
        PullDown: Pins.ValidDioMask,
        OutDefault: 0,
        OutPolarity: 0,
        InPolarity: 0,
        Edge: Pins.ValidDioMask);

    /// <summary>Check every R-M1 rule, the same rules as the firmware
    /// (<c>BAD_MAP</c>). Throws <see cref="ErrorCode.InvalidArgument"/> naming
    /// the first violated field.</summary>
    public void Validate()
    {
        var outputs = Direction;
        var inputs = Pins.ValidDioMask & ~Direction;
        if (Flags != 0)
        {
            throw Invalid($"flags 0x{Flags:x2}: all bits are reserved and must be 0");
        }

        if ((Direction & ~Pins.ValidDioMask) != 0)
        {
            throw Invalid($"direction 0x{Direction:x8} has bits outside the DIO pins");
        }

        Subset("pull_up", PullUp, inputs, "DIO input pins");
        Subset("pull_down", PullDown, inputs, "DIO input pins");
        if ((PullUp & PullDown) != 0)
        {
            throw Invalid(
                $"pull_up & pull_down 0x{PullUp & PullDown:x8}: a pin cannot have both pulls");
        }

        Subset("out_default", OutDefault, outputs, "output pins");
        Subset("out_polarity", OutPolarity, outputs, "output pins");
        Subset("in_polarity", InPolarity, inputs, "DIO input pins");
        Subset("edge", Edge, inputs, "DIO input pins");
    }

    /// <summary>Arguments for <c>map set</c>, equal to the payload of a
    /// <c>map get</c> response (round trip). Validates first, so an invalid
    /// map is never encoded.</summary>
    public string ToSetArgs()
    {
        Validate();
        return string.Create(
            CultureInfo.InvariantCulture,
            $"v={Pins.ProtoVersion} flags=0x{Flags:x2} dir=0x{Direction:x8} pu=0x{PullUp:x8} "
                + $"pd=0x{PullDown:x8} def=0x{OutDefault:x8} opol=0x{OutPolarity:x8} "
                + $"ipol=0x{InPolarity:x8} edge=0x{Edge:x8}");
    }

    /// <summary>Parse the text after <c>OK </c> of a <c>map get</c> response.
    /// The map is validated, so an invalid device response is an error.</summary>
    public static PinMap ParseGet(string args) => Protocol.ParseMap(args);

    private static void Subset(string name, uint value, uint allowed, string what)
    {
        if ((value & ~allowed) != 0)
        {
            throw Invalid($"{name} 0x{value:x8} has bits that are not {what}");
        }
    }

    private static SdkException Invalid(string message) =>
        new(ErrorCode.InvalidArgument, message);
}

/// <summary>One pattern step: output levels held for
/// <see cref="HoldTicks"/> pattern ticks.</summary>
/// <param name="OutBits">Logical output levels (physical GP bits, subset of the direction mask).</param>
/// <param name="HoldTicks">Hold time in pattern ticks of <see cref="Pins.PatternTickNs"/> ns; at least 1.</param>
public sealed record PatternStep(
    uint OutBits,
    uint HoldTicks
)
{
    /// <summary>Check host-side limits: DIO bits only, non-zero hold.</summary>
    public void Validate()
    {
        Pins.CheckDioMask("out_bits", OutBits);
        if (HoldTicks == 0)
        {
            throw new SdkException(ErrorCode.InvalidArgument, "hold_ticks must be at least 1");
        }
    }

    /// <summary>Text form for <c>pattern add</c>: <c>&lt;out_bits&gt;:&lt;hold_ticks&gt;</c>,
    /// e.g. <c>0x1:5</c>.</summary>
    public string ToText()
    {
        Validate();
        return string.Create(CultureInfo.InvariantCulture, $"0x{OutBits:x}:{HoldTicks}");
    }

    /// <summary>Hold time in nanoseconds (the tick part only; the fixed ~133 ns
    /// PIO overhead of each step is not included).</summary>
    public ulong HoldNs() => HoldTicks * (ulong)Pins.PatternTickNs;

    /// <summary>Convert a hold time in nanoseconds to pattern ticks. Only
    /// exact multiples of <see cref="Pins.PatternTickNs"/> are accepted (never
    /// rounded); the result must be between 1 and <see cref="uint.MaxValue"/> ticks.</summary>
    public static uint HoldTicksFromNs(ulong ns)
    {
        if (ns % Pins.PatternTickNs != 0)
        {
            throw new SdkException(
                ErrorCode.InvalidArgument,
                $"{ns} ns is not a multiple of the {Pins.PatternTickNs} ns pattern tick");
        }

        var ticks = ns / Pins.PatternTickNs;
        if (ticks == 0)
        {
            throw new SdkException(
                ErrorCode.InvalidArgument, "hold time must be at least one tick");
        }

        if (ticks > uint.MaxValue)
        {
            throw new SdkException(
                ErrorCode.InvalidArgument, $"{ns} ns exceeds the u32 tick range");
        }

        return (uint)ticks;
    }
}

public enum PatternMode
{
    Once,
    Loop,
}

public enum PatternState
{
    Idle,
    /// <summary>Pattern data loaded but not started.</summary>
    Loaded,
    Running,
    Done,
}

/// <summary>Parsed <c>pattern status</c> response.</summary>
/// <param name="State">Engine state.</param>
/// <param name="Step">Step being output while running, else 0.</param>
/// <param name="Loops">Completed passes.</param>
/// <param name="Total">Steps in the pattern buffer.</param>
public sealed record PatternStatus(
    PatternState State,
    ushort Step,
    ushort Loops,
    ushort Total
);

public enum EdgeMode
{
    Rising,
    Falling,
    Both,
}

/// <summary>Parsed <c>ts status</c> response.</summary>
/// <param name="Armed">The recorder is armed.</param>
/// <param name="Pending">Events waiting in the device ring.</param>
/// <param name="Overflow">The ring overflowed since the last <c>ts get</c>.</param>
public sealed record TsStatus(
    bool Armed,
    uint Pending,
    bool Overflow
);

/// <summary>One captured edge: <c>in=&lt;inputs&gt; c=&lt;count&gt; p=&lt;phase&gt; s=&lt;sync&gt;</c>.
/// The event carries no pre-computed nanosecond value: the caller passes
/// <see cref="Capabilities.TsResNs"/> to <see cref="Ns"/>.</summary>
/// <param name="Inputs">Logical levels of the armed pins, other bits 0.</param>
/// <param name="RawCount">Sync-clock count (<c>s=1</c>) or free-running microsecond timer (<c>s=0</c>).</param>
/// <param name="RawPhase">Sub-microsecond phase in steps of <c>ts_res_ns</c> (0-24).</param>
/// <param name="SyncActive">The sync clock was running at the edge.</param>
public sealed record TimestampEvent(
    uint Inputs,
    uint RawCount,
    byte RawPhase,
    bool SyncActive
)
{
    /// <summary>Nanosecond timestamp (R-TS1). With the sync clock running:
    /// <c>raw_count * 1000 + raw_phase * ts_res_ns</c>. Free running,
    /// <c>raw_count</c> is TIMER0 microseconds and the phase is ignored.
    /// Uncorrected; see <see cref="Reconciler"/>.</summary>
    public long Ns(uint tsResNs) =>
        Reconciler.EventNs(RawCount, RawPhase, SyncActive, tsResNs);
}

/// <summary>Result of <c>ts get</c>.</summary>
/// <param name="Events">Captured events, oldest first.</param>
/// <param name="Overflow">The ring overwrote its oldest events since the last <c>ts get</c>.</param>
public sealed record TimestampResult(
    IReadOnlyList<TimestampEvent> Events,
    bool Overflow
);

public enum SyncRole
{
    Master,
    Slave,
}

public enum SyncState
{
    Idle,
    Armed,
    MasterArmed,
    Clocking,
}

// --- push events ---

/// <summary>Asynchronous push event. The device sends exactly four kinds:
/// <c>! INPUT</c>, <c>! PATTERN_DONE</c>, <c>! PATTERN_TIMEOUT</c> and
/// <c>! FAILSAFE</c>.</summary>
public abstract record PushEvent;

/// <summary><c>! INPUT in=0x%08x t=&lt;u64 us&gt;</c>: logical levels of all
/// input pins and the detection time in microseconds.</summary>
public sealed record InputChangeEvent(uint Inputs, ulong TUs) : PushEvent;

/// <summary><c>! PATTERN_DONE loops=&lt;n&gt;</c>: a pattern run completed normally.</summary>
public sealed record PatternDoneEvent(ushort Loops) : PushEvent;

/// <summary><c>! PATTERN_TIMEOUT loops=&lt;n&gt;</c>: the firmware safety budget
/// aborted the run. The output latch keeps the last step; recover with
/// <c>write</c> or <c>pattern reset</c>.</summary>
public sealed record PatternTimeoutEvent(ushort Loops) : PushEvent;

/// <summary><c>! FAILSAFE cause=&lt;wdog|usb&gt;</c>: the failsafe latch was set
/// (a device with <see cref="Feature.Wdog"/>). The event can be missed, so
/// <see cref="Connection.Safety"/> is the source of truth. <c>Cause</c> is
/// never <see cref="FailsafeCause.None"/>.</summary>
public sealed record FailsafeEvent(FailsafeCause Cause) : PushEvent;
