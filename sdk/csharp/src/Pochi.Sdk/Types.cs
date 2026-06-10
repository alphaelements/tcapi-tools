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
    public bool HasSync => (Features & 0x01) != 0;
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
    bool Reconciled
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

public sealed record SyncDoneEvent(string Status, byte Devnum, ulong Timestamp) : PushEvent;

/// <summary>Unrecognized or malformed push line, preserved verbatim so newer
/// firmware events are observable instead of silently dropped.</summary>
public sealed record UnknownEvent(string Raw) : PushEvent;
