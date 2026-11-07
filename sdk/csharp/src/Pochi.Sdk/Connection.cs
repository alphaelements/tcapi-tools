using System.Globalization;

namespace Pochi.Sdk;

/// <summary>High-level typed connection to one Pochi-DIO device.
/// Mirrors <c>sdk/rust/src/connection.rs</c>. Opening a connection asserts
/// DTR and requires <c>version</c> to report <c>proto=2</c>; any other
/// protocol fails with <see cref="ErrorCode.UnsupportedFirmware"/>.
///
/// The SDK owns the device subscription: attaching the first observer to
/// <see cref="Events"/> sends <c>subscribe on</c>, detaching the last sends
/// <c>subscribe off</c>. There is no public subscribe switch and
/// <see cref="Raw"/> rejects the command. Observers are called on the
/// transport reader thread and must not call back into the connection.
/// The connection is <see cref="IDisposable"/> and closes the port on
/// dispose.</summary>
public sealed class Connection : IDisposable
{
    private readonly Transport _transport;
    private readonly string _portPath;
    private readonly string _firmware;
    private readonly PushEventSource _events;
    private volatile bool _closed;

    private Connection(Transport transport, string portPath, VersionInfo firmware)
    {
        _transport = transport;
        _portPath = portPath;
        _firmware = $"{firmware.Major}.{firmware.Minor}.{firmware.Patch}";
        Firmware = firmware;
        _events = new PushEventSource(
            onFirstSubscriber: () => Ok("subscribe on"),
            onLastUnsubscribed: SubscribeOff);
        _transport.SetEventCallback(_events.Publish);
        _transport.Closed = _events.Complete;
    }

    // --- constructors ---

    /// <summary>Open a connection to the device at the given serial port path.</summary>
    public static Connection Open(string port) => Handshake(Transport.Open(port), port);

    /// <summary>Discover devices and connect to the one with the given UID.</summary>
    public static Connection OpenByUid(string uid) =>
        Open(Discovery.FindByUid(Discovery.Discover(), uid).Port);

    /// <summary>Discover devices and connect by device number.</summary>
    public static Connection OpenByDeviceNumber(byte n) =>
        Open(Discovery.FindByDeviceNumber(Discovery.Discover(), n).Port);

    /// <summary>Discover devices and connect to the sole connected device.</summary>
    public static Connection OpenSoleDevice() =>
        Open(Discovery.SelectSoleDevice(Discovery.Discover()).Port);

    /// <summary>Wrap an already-open port (fake-port tests, custom
    /// transports). The protocol handshake is performed like for
    /// <see cref="Open"/>.</summary>
    public static Connection FromPort(IDuplexPort port) => Handshake(new Transport(port), "");

    private static Connection Handshake(Transport transport, string portPath)
    {
        try
        {
            return new Connection(transport, portPath, RequireProto(transport));
        }
        catch
        {
            transport.Dispose();
            throw;
        }
    }

    /// <summary>Send <c>version</c> and require the protocol this SDK speaks.
    /// A device that reports any other <c>proto</c> (or a version line the SDK
    /// cannot read but that names another protocol) is
    /// <see cref="ErrorCode.UnsupportedFirmware"/>; nothing is parsed
    /// leniently.</summary>
    internal static VersionInfo RequireProto(Transport transport)
    {
        var data = transport.Command("version");
        VersionInfo version;
        try
        {
            version = Protocol.ParseVersion(data);
        }
        catch (SdkException ex) when (ex.Code == ErrorCode.Parse)
        {
            var proto = Array.Find(
                data.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries),
                p => p.StartsWith("proto=", StringComparison.Ordinal));
            if (proto is not null && proto != $"proto={Pins.ProtoVersion}")
            {
                throw SdkException.UnsupportedFirmware(
                    $"device reports {proto}, this SDK speaks proto={Pins.ProtoVersion}");
            }

            throw;
        }

        if (version.ProtocolVersion != Pins.ProtoVersion)
        {
            throw SdkException.UnsupportedFirmware(
                $"device reports proto={version.ProtocolVersion}, "
                    + $"this SDK speaks proto={Pins.ProtoVersion}");
        }

        return version;
    }

    // --- lifecycle ---

    /// <summary>The firmware version reported by the opening handshake.</summary>
    public VersionInfo Firmware { get; }

    /// <summary>Command response timeout (default 2 seconds).</summary>
    public TimeSpan CommandTimeout
    {
        get => _transport.CommandTimeout;
        set => _transport.CommandTimeout = value;
    }

    /// <summary>Receives errors with no caller to throw to: unknown event
    /// lines (discarded) and exceptions thrown by observers. Defaults to
    /// <see cref="System.Diagnostics.Trace.TraceError(string)"/> when null.</summary>
    public Action<string>? ErrorLog
    {
        get => _transport.ErrorLog;
        set => _transport.ErrorLog = value;
    }

    /// <summary>Push events (<c>! INPUT</c>, <c>! PATTERN_DONE</c>,
    /// <c>! PATTERN_TIMEOUT</c>, <c>! FAILSAFE</c>), delivered on the reader thread, including
    /// while commands are in flight. Subscribing to the first observer sends
    /// <c>subscribe on</c> and throws the device error if it is refused (for
    /// example <see cref="ErrorCode.NoResource"/> with no input pins);
    /// disposing the last subscription sends <c>subscribe off</c>. Subscribing
    /// after close completes immediately.</summary>
    public IObservable<PushEvent> Events => _events;

    /// <summary>Close the connection. Sends no command and changes no output; a
    /// running <see cref="Heartbeat"/> ends silently.</summary>
    public void Close()
    {
        _closed = true;
        _transport.Close();
        _events.Complete();
    }

    /// <summary>True once <see cref="Close"/> was called on this object (a
    /// device that went away is reported by the operations, not by this flag).</summary>
    internal bool IsClosed => _closed;

    /// <summary>Report an error with no caller to throw to, through
    /// <see cref="ErrorLog"/>.</summary>
    internal void LogError(string message) => _transport.LogError(message);

    public void Dispose() => Close();

    // --- command helpers ---

    /// <summary>Send a command whose success response is a bare <c>OK</c>.</summary>
    private void Ok(string command)
    {
        var data = _transport.Command(command);
        if (data.Length != 0)
        {
            _transport.MarkDesync();
            throw new SdkException(
                ErrorCode.Parse, $"unexpected data in response to {command}: OK {data}");
        }
    }

    /// <summary>Send a command and parse its OK data. A response that cannot
    /// be parsed leaves the stream out of step, so the next operation
    /// resynchronises.</summary>
    private T Query<T>(string command, Func<string, T> parse) =>
        Parsed(_transport.Command(command), parse);

    private T Parsed<T>(string data, Func<string, T> parse)
    {
        try
        {
            return parse(data);
        }
        catch (SdkException ex) when (ex.Code == ErrorCode.Parse)
        {
            _transport.MarkDesync();
            throw;
        }
    }

    private void SubscribeOff()
    {
        try
        {
            Ok("subscribe off");
        }
        catch (SdkException ex) when (ex.Code == ErrorCode.Disconnected)
        {
            // The connection is gone, and the device subscription ends with
            // it (DTR falling turns it off); there is nothing left to switch.
        }
    }

    // --- device information ---

    /// <summary><c>version</c> — firmware and protocol version.</summary>
    public VersionInfo Version() => Query("version", Protocol.ParseVersion);

    /// <summary><c>caps</c> — device capabilities.</summary>
    public Capabilities Caps() => Query("caps", Protocol.ParseCaps);

    /// <summary><c>info</c> — device identification (UID, device number).</summary>
    public DeviceInfo Info()
    {
        var (uid, deviceNumber) = Query("info", Protocol.ParseInfo);
        return new DeviceInfo(uid, deviceNumber, _portPath, _firmware);
    }

    /// <summary><c>devnum &lt;n&gt;</c> — set the device number (0-254; 255 unassigns).</summary>
    public void SetDeviceNumber(byte n) => Ok(Protocol.DevnumCommand(n));

    /// <summary><c>ping &lt;value&gt;</c> — returns the echoed value. A different
    /// echo is a <see cref="ErrorCode.Parse"/> error. Also the transport's
    /// resynchronisation primitive.</summary>
    public uint Ping(uint value)
    {
        var pong = Query(Protocol.PingCommand(value), Protocol.ParsePong);
        if (pong != value)
        {
            _transport.MarkDesync();
            throw new SdkException(
                ErrorCode.Parse, $"ping {value} was answered with pong={pong}");
        }

        return pong;
    }

    // --- digital I/O ---

    /// <summary><c>read</c> — logical levels of the input pins.</summary>
    public uint Read() => Query("read", Protocol.ParseRead);

    /// <summary><c>write &lt;values&gt; &lt;mask&gt;</c> — set outputs (masked bits
    /// only). Bits outside the DIO pins are rejected before anything is sent;
    /// a mask on a non-output pin is refused by the device
    /// (<see cref="ErrorCode.BadParam"/>).</summary>
    public void Write(uint values, uint mask) => Ok(Protocol.WriteCommand(values, mask));

    /// <summary><c>state</c> — input levels and the output latch.</summary>
    public IoState State() => Query("state", Protocol.ParseState);

    // --- pin map ---

    /// <summary><c>map get</c> — the current pin map (validated).</summary>
    public PinMap MapGet() => Query("map get", PinMap.ParseGet);

    /// <summary><c>map set</c> — validates <paramref name="map"/> first. Fails
    /// with <see cref="ErrorCode.Busy"/> while a pattern is running; on success
    /// the pattern engine returns to idle and the timestamp recorder is
    /// disarmed.</summary>
    public void MapSet(PinMap map) => Ok(Protocol.MapSetCommand(map));

    /// <summary><c>map save</c> — persist the current map to flash.</summary>
    public void MapSave() => Ok("map save");

    /// <summary><c>map default</c> — reset the RAM map to the default map.</summary>
    public void MapDefault() => Ok("map default");

    // --- pattern ---

    /// <summary>One <c>pattern add</c> line (atomic on the device). Returns the
    /// total number of steps now in the buffer. The steps must fit one 256-byte
    /// line; use <see cref="PatternLoad"/> for longer patterns.</summary>
    public ushort PatternAdd(IReadOnlyList<PatternStep> steps)
    {
        var lines = Protocol.PatternAddCommands(steps);
        if (lines.Count != 1)
        {
            throw new SdkException(
                ErrorCode.InvalidArgument,
                $"{steps.Count} steps do not fit one {Protocol.MaxLineBytes}-byte line; "
                    + "use PatternLoad");
        }

        return Query(lines[0], Protocol.ParsePatternTotal);
    }

    /// <summary><c>pattern reset</c>, then <c>pattern add</c> in as many chunks
    /// as needed, each packed to at most 256 bytes per line. Returns the final
    /// total. All steps are validated before anything is sent.</summary>
    public ushort PatternLoad(IReadOnlyList<PatternStep> steps)
    {
        var lines = Protocol.PatternAddCommands(steps);
        PatternReset();
        ushort total = 0;
        foreach (var line in lines)
        {
            total = Query(line, Protocol.ParsePatternTotal);
        }

        return total;
    }

    /// <summary><c>pattern run</c> — <see cref="PatternMode.Once"/> plays one
    /// pass (the repeat is ignored); <see cref="PatternMode.Loop"/> requires a
    /// repeat of 1-65535. Completion arrives as a <see cref="PatternDoneEvent"/>,
    /// a firmware safety timeout as a <see cref="PatternTimeoutEvent"/>.</summary>
    public void PatternRun(PatternMode mode, ushort repeat) =>
        Ok(Protocol.PatternRunCommand(mode, repeat));

    /// <summary><c>pattern stop</c> — stop playback; the steps stay loaded.
    /// Fails with <see cref="ErrorCode.NotRunning"/> when the engine is not
    /// running.</summary>
    public void PatternStop() => Ok("pattern stop");

    /// <summary><c>pattern status</c> — current playback status.</summary>
    public PatternStatus PatternStatus() => Query("pattern status", Protocol.ParsePatternStatus);

    /// <summary><c>pattern reset</c> — abort any run, clear the buffer and
    /// return to idle. USB stays up.</summary>
    public void PatternReset() => Ok("pattern reset");

    // --- reset ---

    /// <summary><c>reset</c> — reboot the device. USB re-enumerates, so this
    /// connection must be disposed and the device rediscovered. RAM state
    /// returns to defaults; flash state is kept.</summary>
    public void Reset() => Ok("reset");

    /// <summary><c>bootsel</c> — reboot into BOOTSEL mass-storage mode for UF2
    /// reflash. The connection must be disposed afterwards.</summary>
    public void Bootsel() => Ok("bootsel");

    // --- timestamp ---

    /// <summary><c>ts arm &lt;mask&gt; &lt;mode&gt;</c> — arm timestamp capture. The
    /// mask must be non-zero and inside the DIO pins.</summary>
    public void TsArm(uint mask, EdgeMode mode) => Ok(Protocol.TsArmCommand(mask, mode));

    /// <summary><c>ts get &lt;max&gt;</c> — retrieve captured events (counted
    /// read of exactly the announced number of lines). <paramref name="maxEvents"/>
    /// must be 1-85; draining a full ring takes several calls. The result carries
    /// no nanosecond values: use <see cref="TimestampEvent.Ns"/> or
    /// <see cref="Reconciler"/> with <see cref="Capabilities.TsResNs"/>.</summary>
    public TimestampResult TsGet(ushort maxEvents)
    {
        var (data, lines) = _transport.CommandCounted(Protocol.TsGetCommand(maxEvents));
        return Parsed(data, header =>
        {
            var (count, overflow) = Protocol.ParseTsGetHeader(header);
            if (count > maxEvents)
            {
                throw new SdkException(
                    ErrorCode.Parse, $"ts get {maxEvents} answered with count={count}");
            }

            return new TimestampResult(
                lines.Select(Protocol.ParseTsEventLine).ToArray(), overflow);
        });
    }

    /// <summary><c>ts status</c> — recorder state (does not clear the overflow flag).</summary>
    public TsStatus TsStatus() => Query("ts status", Protocol.ParseTsStatus);

    /// <summary><c>ts disarm</c> — disarm capture and discard buffered events.</summary>
    public void TsDisarm() => Ok("ts disarm");

    // --- sync ---

    /// <summary><c>sync arm</c> — prepare as slave.</summary>
    public void SyncArm() => Ok("sync arm");

    /// <summary><c>sync master</c> — prepare as master.</summary>
    public void SyncMaster() => Ok("sync master");

    /// <summary><c>sync start</c> — start sync pulse + 1 MHz clock (master only).</summary>
    public void SyncStart() => Ok("sync start");

    /// <summary><c>sync stop</c> — stop clock output (master only).</summary>
    public void SyncStop() => Ok("sync stop");

    /// <summary><c>sync count</c> — current sync clock count. A single line
    /// (<c>OK clocks=N</c>), not a counted response.</summary>
    public ulong SyncCount() => Query("sync count", Protocol.ParseSyncCount);

    /// <summary><c>sync disarm</c> — return to idle (always accepted).</summary>
    public void SyncDisarm() => Ok("sync disarm");

    // --- safety functions ---

    /// <summary><c>wdog &lt;ms&gt;</c> — set the watchdog timeout (0 disables it,
    /// otherwise 100-10000; CDC only). Every <c>OK</c> answer restarts the timer;
    /// when it expires the device sets the failsafe latch and puts the outputs at
    /// their <c>def</c>. With the watchdog on, keep the device busy:
    /// <see cref="StartHeartbeat"/>.</summary>
    public void Wdog(uint ms) => Ok(Protocol.WdogCommand(ms));

    /// <summary><c>safety</c> — the safety state (watchdog, failsafe latch,
    /// <c>usbsafe</c>, number of exclusive groups). The source of truth for
    /// <see cref="FailsafeEvent"/>.</summary>
    public SafetyState Safety() => Query("safety", Protocol.ParseSafety);

    /// <summary><c>failsafe clear</c> — release the failsafe latch (CDC only). The
    /// outputs stay where they are and the watchdog timer restarts.</summary>
    public void FailsafeClear() => Ok("failsafe clear");

    /// <summary><c>outputs reset</c> — put every output at its <c>def</c> (the safe
    /// state) and stop a running pattern. Always succeeds on the device, also with
    /// the latch set.</summary>
    public void OutputsReset() => Ok("outputs reset");

    /// <summary><c>excl set</c> — replace all exclusive groups atomically: 1 to 16
    /// masks, each a subset of the DIO pins with at least 2 bits (CDC only).
    /// That every pin is an output depends on the active map and is answered by
    /// the device (<see cref="ErrorCode.BadParam"/>).</summary>
    public void ExclSet(IReadOnlyList<uint> masks) => Ok(Protocol.ExclSetCommand(masks));

    /// <summary><c>excl clear</c> — remove all exclusive groups (CDC only).</summary>
    public void ExclClear() => Ok("excl clear");

    /// <summary><c>excl get</c> — the exclusive groups in the order they were set
    /// (a counted response; at most 16).</summary>
    public IReadOnlyList<uint> ExclGet()
    {
        var (header, lines) = _transport.CommandCounted("excl get");
        return Parsed(header, h => Protocol.ParseExclGet(h, lines));
    }

    /// <summary><c>usbsafe on|off</c> — set the failsafe for a lost USB link (CDC only).</summary>
    public void UsbSafe(bool on) => Ok(Protocol.UsbsafeCommand(on));

    /// <summary><c>rstinfo</c> — cause and time of the last restart.</summary>
    public ResetInfo RstInfo() => Query("rstinfo", Protocol.ParseRstinfo);

    /// <summary><c>pads</c> — the recorded outputs and the level read back from the pads.</summary>
    public Pads Pads() => Query("pads", Protocol.ParsePads);

    /// <summary>Make the device equal to a <c>safety.toml</c> (config-files.md
    /// section 7, DD-16) and check the result. The rules are identical in every SDK:
    /// <list type="number">
    /// <item>The configuration is validated first; a value the device would refuse is
    /// <see cref="ErrorCode.InvalidArgument"/> and nothing is sent.</item>
    /// <item>The commands go out in this order and nothing else: <c>excl set</c> (or
    /// <c>excl clear</c> only when the file has no groups), <c>usbsafe on|off</c>,
    /// <c>wdog &lt;ms&gt;</c>.</item>
    /// <item>The first error answered by the device stops the apply: later commands
    /// are not sent, no read-back is attempted and the error keeps its code.
    /// Accepted commands stay in effect (no rollback).</item>
    /// <item>After the last command the SDK reads <c>safety</c> and <c>excl get</c>
    /// and compares them with the file (watchdog, usbsafe, group count and masks in
    /// order); a difference is <see cref="ErrorCode.SafetyMismatch"/> listing every
    /// difference. The latch and <see cref="SafetyState.RemainingMs"/> are not
    /// compared.</item>
    /// </list>
    /// The pins of the groups must already be outputs: apply <c>map.toml</c> first.
    /// Returns the <c>safety</c> state that was read, which also shows a failsafe
    /// latch that was set before. With a watchdog configured, start the heartbeat
    /// afterwards.</summary>
    public SafetyState ApplySafety(SafetyConfig config)
    {
        ArgumentNullException.ThrowIfNull(config);
        foreach (var command in config.Commands())
        {
            Ok(command);
        }

        var state = Safety();
        var groups = ExclGet();
        var differences = new List<string>();
        if (state.WdogMs != config.WatchdogMs)
        {
            differences.Add($"wdog_ms is {state.WdogMs}, expected {config.WatchdogMs}");
        }

        if (state.UsbSafe != config.UsbSafe)
        {
            differences.Add(
                $"usbsafe is {(state.UsbSafe ? 1 : 0)}, expected {(config.UsbSafe ? 1 : 0)}");
        }

        if (state.Excl != config.Groups.Count)
        {
            differences.Add($"excl is {state.Excl}, expected {config.Groups.Count}");
        }

        if (groups.Count != config.Groups.Count)
        {
            differences.Add(
                $"excl get returned {groups.Count} groups, expected {config.Groups.Count}");
        }

        for (var i = 0; i < Math.Min(groups.Count, config.Groups.Count); i++)
        {
            if (groups[i] != config.Groups[i])
            {
                differences.Add(
                    $"group {i} is 0x{groups[i]:x8}, expected 0x{config.Groups[i]:x8}");
            }
        }

        return differences.Count == 0
            ? state
            : throw new SdkException(ErrorCode.SafetyMismatch, string.Join("; ", differences));
    }

    /// <summary>Start the watchdog heartbeat: a dedicated thread sends <c>ping</c>
    /// every timeout / 4 (at most 1 s) so the device keeps seeing <c>OK</c>
    /// answers. <paramref name="timeoutMs"/> is the value given to
    /// <see cref="Wdog"/> (100-10000). See <see cref="Heartbeat"/> for the rules
    /// (serialised with every other command, one failure is reported and not
    /// retried, closing the connection or the heartbeat changes no output).
    /// Using it is optional.</summary>
    public Heartbeat StartHeartbeat(uint timeoutMs) => Heartbeat.Start(this, timeoutMs);

    // --- escape hatch ---

    /// <summary>Send an arbitrary text command and return <b>every</b> line of
    /// the response (for a counted response: the header and all N lines),
    /// under the same rules as every other command. A line over 256 bytes, a
    /// line holding CR/LF, and <c>subscribe</c> (owned by the SDK) are
    /// rejected locally with <see cref="ErrorCode.InvalidArgument"/>.</summary>
    public IReadOnlyList<string> Raw(string command)
    {
        ArgumentNullException.ThrowIfNull(command);
        var first = command.Split(new[] { ' ', '\t' }, StringSplitOptions.RemoveEmptyEntries)
            .FirstOrDefault();
        if (string.Equals(first, "subscribe", StringComparison.OrdinalIgnoreCase))
        {
            throw new SdkException(
                ErrorCode.InvalidArgument,
                "subscribe is owned by the SDK; subscribe to Connection.Events instead");
        }

        return _transport.Raw(command);
    }
}
