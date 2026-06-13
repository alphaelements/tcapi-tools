using System.Text.Json.Serialization;

namespace Pochi.Sdk;

// Core types shared across the SDK. Mirrors the Rust reference
// implementation (sdk/rust/src/types.rs). Serialize via WireJson to get the
// snake_case wire format (docs/sdk-api-design.md §6).

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

/// <summary>Bit flags for <see cref="Capabilities.Features"/>.</summary>
public static class Feature
{
    /// <summary><c>caps.features</c> bit 0: multi-device clock sync
    /// (<c>SYNC_*</c> commands).</summary>
    public const uint Sync = 0x1;

    /// <summary><c>caps.features</c> bit 1: reset commands
    /// (<c>PATTERN_RESET</c> / <c>SYSTEM_RESET</c> / <c>BOOTSEL_RESET</c>).
    /// Set by FW v0.1.3+.</summary>
    public const uint Reset = 0x2;
}

public sealed record Capabilities(
    byte ProtocolVersion,
    byte MaxDio,
    byte OutCount,
    byte InCount,
    uint TsResolutionNs,
    ushort MaxPatternSteps,
    ushort TsRingEvents,
    uint Features
)
{
    /// <summary>True if bit 0 of <see cref="Features"/> (sync capability) is set.</summary>
    [JsonIgnore]
    public bool HasSync => (Features & Feature.Sync) != 0;

    /// <summary>True if the device supports <c>PATTERN_RESET</c> /
    /// <c>SYSTEM_RESET</c> / <c>BOOTSEL_RESET</c> (FW v0.1.3+).</summary>
    [JsonIgnore]
    public bool HasReset => (Features & Feature.Reset) != 0;
}

public sealed record IoState(
    uint Inputs,
    uint Outputs,
    byte Flags
);

public enum PullMode
{
    None,
    Up,
    Down,
}

public sealed record PinMap(
    byte Version,
    byte OutBase,
    byte OutCount,
    byte InBase,
    byte InCount,
    PullMode Pull,
    byte Flags
);

public sealed record PatternStep(
    uint OutBits,
    uint HoldUs
);

public enum PatternMode
{
    Once,
    Loop,
}

public enum PatternState
{
    Idle,
    /// <summary>Pattern data loaded but not started (FW state 1).</summary>
    Loaded,
    Running,
    Done,
}

public sealed record PatternStatus(
    PatternState State,
    ushort CurrentStep,
    ushort LoopsDone
);

public enum EdgeMode
{
    Rising,
    Falling,
    Both,
}

public sealed record TimestampEvent(
    uint Inputs,
    uint RawCount,
    byte RawPhase,
    bool SyncActive,
    // TimestampNs is host-computed: raw_count * 1000 + raw_phase * 40 (uncorrected).
    long TimestampNs
);

public sealed record TimestampResult(
    IReadOnlyList<TimestampEvent> Events,
    bool Reconciled,
    // True if the FW reported a ring overflow since the last `ts get`
    // (i.e. events were dropped). False for FW without the `overflow=`
    // field in the `ts get` response.
    bool Overflow = false
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

public abstract record PushEvent;

public sealed record InputChangeEvent(uint Inputs, ulong TimestampUs) : PushEvent;

public sealed record PatternDoneEvent(ushort Loops) : PushEvent;

/// <summary>Pattern aborted by the FW wall-clock safety budget (FW v0.1.3+).
/// The SM / DMA are forced to a safe state; outputs hold the last written step
/// value until the host issues SET_OUTPUTS or PATTERN_RESET.</summary>
public sealed record PatternTimeoutEvent(ushort Loops) : PushEvent;

public sealed record SyncDoneEvent(string Status, byte Devnum, ulong Timestamp) : PushEvent;

/// <summary>Unrecognized or malformed push line, preserved verbatim so newer
/// firmware events are observable instead of silently dropped.</summary>
public sealed record UnknownEvent(string Raw) : PushEvent;
