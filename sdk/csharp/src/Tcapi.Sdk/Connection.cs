using System.Diagnostics.CodeAnalysis;
using System.Globalization;

namespace Tcapi.Sdk;

/// <summary>High-level typed connection to one Tcapi-DIO device.
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
    private readonly ConnectionOptions _options;
    private volatile string? _uid;
    private readonly PushEventSource _events;
    private volatile bool _closed;

    private Connection(
        Transport transport, string portPath, VersionInfo firmware, ConnectionOptions options)
    {
        _transport = transport;
        _portPath = portPath;
        _options = options;
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
    /// <param name="port">Serial port path (<c>/dev/ttyACM0</c>, <c>COM3</c>).</param>
    /// <param name="options">Connection options; null = <see cref="ConnectionOptions.Default"/>.
    /// </param>
    /// <param name="cancellationToken">Cancels the handshake; the port is closed.</param>
    public static Connection Open(
        string port,
        ConnectionOptions? options = null,
        CancellationToken cancellationToken = default)
    {
        var effective = options ?? ConnectionOptions.Default;
        cancellationToken.ThrowIfCancellationRequested();
        return Handshake(
            Transport.Open(port, effective.OmitPortPathFromErrors), port, effective,
            cancellationToken);
    }

    /// <summary>Discover devices and connect to the one with the given UID.</summary>
    public static Connection OpenByUid(
        string uid,
        ConnectionOptions? options = null,
        CancellationToken cancellationToken = default)
    {
        var device = Discovery.FindByUid(Discovery.Discover(options, cancellationToken), uid);
        var connection = Open(device.Port, options, cancellationToken);
        connection._uid = device.Uid;
        return connection;
    }

    /// <summary>Discover devices and connect by device number.</summary>
    public static Connection OpenByDeviceNumber(
        byte n,
        ConnectionOptions? options = null,
        CancellationToken cancellationToken = default) =>
        Open(
            Discovery.FindByDeviceNumber(Discovery.Discover(options, cancellationToken), n).Port,
            options, cancellationToken);

    /// <summary>Discover devices and connect to the sole connected device.</summary>
    public static Connection OpenSoleDevice(
        ConnectionOptions? options = null,
        CancellationToken cancellationToken = default) =>
        Open(
            Discovery.SelectSoleDevice(Discovery.Discover(options, cancellationToken)).Port,
            options, cancellationToken);

    /// <summary>Wrap an already-open port (fake-port tests, custom
    /// transports). The protocol handshake is performed like for
    /// <see cref="Open"/>.</summary>
    public static Connection FromPort(
        IDuplexPort port,
        ConnectionOptions? options = null,
        CancellationToken cancellationToken = default) =>
        Handshake(new Transport(port), "", options ?? ConnectionOptions.Default, cancellationToken);

    private static Connection Handshake(
        Transport transport,
        string portPath,
        ConnectionOptions options,
        CancellationToken cancellationToken)
    {
        try
        {
            return new Connection(
                transport, portPath, RequireProto(transport, cancellationToken), options);
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
    internal static VersionInfo RequireProto(
        Transport transport, CancellationToken cancellationToken = default)
    {
        var data = transport.Command("version", cancellationToken);
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

    // --- results ---

    /// <summary>Run <paramref name="operation"/> on this connection and return
    /// its outcome instead of throwing: the result of any command as an
    /// <see cref="SdkResult{T}"/>, for example <c>conn.Try(c =&gt; c.Read())</c>.
    /// Only <see cref="SdkException"/> is captured; pass a token to the call
    /// inside to make it cancellable (a cancellation still throws).</summary>
    public SdkResult<T> Try<T>(Func<Connection, T> operation)
    {
        ArgumentNullException.ThrowIfNull(operation);
        return SdkResult.Capture(() => operation(this));
    }

    /// <summary><see cref="Try{T}"/> for a command without a result, for
    /// example <c>conn.Try(c =&gt; c.PatternStop())</c>.</summary>
    public SdkResult Try(Action<Connection> operation)
    {
        ArgumentNullException.ThrowIfNull(operation);
        return SdkResult.Capture(() => operation(this));
    }

    /// <summary><see cref="Open"/> without throwing for an SDK error: false and
    /// the error instead.</summary>
    public static bool TryOpen(
        string port,
        [NotNullWhen(true)] out Connection? connection,
        [NotNullWhen(false)] out SdkException? error,
        ConnectionOptions? options = null,
        CancellationToken cancellationToken = default) =>
        SdkResult.TryInvoke(
            () => Open(port, options, cancellationToken), out connection, out error);

    /// <summary><see cref="OpenByUid"/> without throwing for an SDK error.</summary>
    public static bool TryOpenByUid(
        string uid,
        [NotNullWhen(true)] out Connection? connection,
        [NotNullWhen(false)] out SdkException? error,
        ConnectionOptions? options = null,
        CancellationToken cancellationToken = default) =>
        SdkResult.TryInvoke(
            () => OpenByUid(uid, options, cancellationToken), out connection, out error);

    /// <summary><see cref="OpenByDeviceNumber"/> without throwing for an SDK error.</summary>
    public static bool TryOpenByDeviceNumber(
        byte n,
        [NotNullWhen(true)] out Connection? connection,
        [NotNullWhen(false)] out SdkException? error,
        ConnectionOptions? options = null,
        CancellationToken cancellationToken = default) =>
        SdkResult.TryInvoke(
            () => OpenByDeviceNumber(n, options, cancellationToken), out connection, out error);

    /// <summary><see cref="OpenSoleDevice"/> without throwing for an SDK error.</summary>
    public static bool TryOpenSoleDevice(
        [NotNullWhen(true)] out Connection? connection,
        [NotNullWhen(false)] out SdkException? error,
        ConnectionOptions? options = null,
        CancellationToken cancellationToken = default) =>
        SdkResult.TryInvoke(
            () => OpenSoleDevice(options, cancellationToken), out connection, out error);

    // --- reconnecting by UID ---

    /// <summary>How often a reconnect looks for the device.</summary>
    public static readonly TimeSpan ReconnectPollInterval = TimeSpan.FromMilliseconds(250);

    /// <summary>The UID of the device, once known: after <see cref="Info"/> was
    /// called on this connection, or when it was opened by
    /// <see cref="OpenByUid"/>. Null before that — the opening handshake does
    /// not ask for it, so a connection to a device that is never asked costs
    /// nothing extra.</summary>
    public string? Uid => _uid;

    /// <summary>Wait for the device with the given UID to be present and
    /// connect to it. The port path changes when a device re-enumerates (after
    /// <see cref="Reset"/>, <see cref="Bootsel"/> and a flash, or a replug), the
    /// UID does not: this looks the device up by UID every
    /// <see cref="ReconnectPollInterval"/> until it answers or
    /// <paramref name="timeout"/> has passed. A port that is busy or not ready
    /// yet is tried again; a failure that retrying cannot fix (a device on
    /// another protocol, discovery unavailable on this platform) is thrown at
    /// once. At the deadline the error is <see cref="ErrorCode.NoDevice"/>.
    /// A zero <paramref name="timeout"/> makes exactly one attempt.</summary>
    public static Connection ReconnectByUid(
        string uid,
        TimeSpan timeout,
        ConnectionOptions? options = null,
        CancellationToken cancellationToken = default) =>
        ReconnectByUid(
            uid, timeout, ReconnectPollInterval, options, cancellationToken,
            Discovery.DiscoverDetailed, Open);

    /// <summary>The static <c>ReconnectByUid</c> without throwing for an SDK error.</summary>
    public static bool TryReconnectByUid(
        string uid,
        TimeSpan timeout,
        [NotNullWhen(true)] out Connection? connection,
        [NotNullWhen(false)] out SdkException? error,
        ConnectionOptions? options = null,
        CancellationToken cancellationToken = default) =>
        SdkResult.TryInvoke(
            () => ReconnectByUid(uid, timeout, options, cancellationToken),
            out connection, out error);

    /// <summary>Close this connection and connect again to the same device,
    /// found by its <see cref="Uid"/> (see the static <c>ReconnectByUid</c>).
    /// The new connection is a new object with the same options: subscriptions
    /// to <see cref="Events"/>, a running <see cref="Heartbeat"/> and every
    /// setting held in the device's RAM are not carried over. Fails with
    /// <see cref="ErrorCode.InvalidArgument"/> when the UID is not known yet.</summary>
    public Connection Reconnect(TimeSpan timeout, CancellationToken cancellationToken = default)
    {
        var uid = _uid ?? throw new SdkException(
            ErrorCode.InvalidArgument,
            "the device UID is not known yet; call Info() first or open the connection by UID");
        Close();
        return ReconnectByUid(uid, timeout, _options, cancellationToken);
    }

    internal static Connection ReconnectByUid(
        string uid,
        TimeSpan timeout,
        TimeSpan pollInterval,
        ConnectionOptions? options,
        CancellationToken cancellationToken,
        Func<ConnectionOptions?, CancellationToken, DiscoveryResult> discover,
        Func<string, ConnectionOptions?, CancellationToken, Connection> open)
    {
        ArgumentNullException.ThrowIfNull(uid);
        if (timeout < TimeSpan.Zero)
        {
            throw new SdkException(
                ErrorCode.InvalidArgument,
                $"reconnect timeout must not be negative, got {timeout}");
        }

        var deadline = Environment.TickCount64 + (long)timeout.TotalMilliseconds;
        SdkException? last = null;
        while (true)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var found = discover(options, cancellationToken);
            var device = found.Devices.FirstOrDefault(
                d => string.Equals(d.Uid, uid, StringComparison.OrdinalIgnoreCase));
            if (device is not null)
            {
                try
                {
                    var connection = open(device.Port, options, cancellationToken);
                    connection._uid = device.Uid;
                    return connection;
                }
                catch (SdkException ex) when (ex.Code is ErrorCode.Io or ErrorCode.Timeout
                    or ErrorCode.Disconnected)
                {
                    last = ex; // enumerated but not ready or still held: try again
                }
            }
            else if (found.Failures.Count > 0)
            {
                // The device may be one of the ports that could not be probed yet.
                last = found.Failures[^1].Error;
            }

            var remaining = deadline - Environment.TickCount64;
            if (remaining <= 0)
            {
                var omit = (options ?? ConnectionOptions.Default).OmitPortPathFromErrors;
                var message = $"no Tcapi-DIO device with UID {uid} appeared within "
                    + $"{(long)timeout.TotalMilliseconds} ms"
                    + (last is null ? "" : $" (last error: {last.Message})");
                throw omit || last is null
                    ? new SdkException(ErrorCode.NoDevice, message)
                    : new SdkException(ErrorCode.NoDevice, message, last);
            }

            // A cancelled token ends the wait at once; the loop top throws.
            cancellationToken.WaitHandle.WaitOne(
                (int)Math.Min(remaining, (long)pollInterval.TotalMilliseconds));
        }
    }

    // --- command helpers ---

    /// <summary>Send a command whose success response is a bare <c>OK</c>.</summary>
    private void Ok(string command, CancellationToken cancellationToken = default)
    {
        var data = _transport.Command(command, cancellationToken);
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
    private T Query<T>(
        string command, Func<string, T> parse, CancellationToken cancellationToken = default) =>
        Parsed(_transport.Command(command, cancellationToken), parse);

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
    public VersionInfo Version(CancellationToken cancellationToken = default) =>
        Query("version", Protocol.ParseVersion, cancellationToken);

    /// <summary><c>caps</c> — device capabilities.</summary>
    public Capabilities Caps(CancellationToken cancellationToken = default) =>
        Query("caps", Protocol.ParseCaps, cancellationToken);

    /// <summary><c>info</c> — device identification (UID, device number).</summary>
    public DeviceInfo Info(CancellationToken cancellationToken = default)
    {
        var (uid, deviceNumber) = Query("info", Protocol.ParseInfo, cancellationToken);
        _uid = uid;
        return new DeviceInfo(uid, deviceNumber, _portPath, _firmware);
    }

    /// <summary><c>devnum &lt;n&gt;</c> — set the device number (0-254; 255 unassigns).</summary>
    public void SetDeviceNumber(byte n, CancellationToken cancellationToken = default) =>
        Ok(Protocol.DevnumCommand(n), cancellationToken);

    /// <summary><c>ping &lt;value&gt;</c> — returns the echoed value. A different
    /// echo is a <see cref="ErrorCode.Parse"/> error. Also the transport's
    /// resynchronisation primitive.</summary>
    public uint Ping(uint value, CancellationToken cancellationToken = default)
    {
        var pong = Query(Protocol.PingCommand(value), Protocol.ParsePong, cancellationToken);
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
    public uint Read(CancellationToken cancellationToken = default) =>
        Query("read", Protocol.ParseRead, cancellationToken);

    /// <summary><c>write &lt;values&gt; &lt;mask&gt;</c> — set outputs (masked bits
    /// only). Bits outside the DIO pins are rejected before anything is sent;
    /// a mask on a non-output pin is refused by the device
    /// (<see cref="ErrorCode.BadParam"/>).</summary>
    public void Write(uint values, uint mask, CancellationToken cancellationToken = default) =>
        Ok(Protocol.WriteCommand(values, mask), cancellationToken);

    /// <summary><c>state</c> — input levels and the output latch.</summary>
    public IoState State(CancellationToken cancellationToken = default) =>
        Query("state", Protocol.ParseState, cancellationToken);

    // --- pin map ---

    /// <summary><c>map get</c> — the current pin map (validated).</summary>
    public PinMap MapGet(CancellationToken cancellationToken = default) =>
        Query("map get", PinMap.ParseGet, cancellationToken);

    /// <summary><c>map set</c> — validates <paramref name="map"/> first. Fails
    /// with <see cref="ErrorCode.Busy"/> while a pattern is running; on success
    /// the pattern engine returns to idle and the timestamp recorder is
    /// disarmed.</summary>
    public void MapSet(PinMap map, CancellationToken cancellationToken = default) =>
        Ok(Protocol.MapSetCommand(map), cancellationToken);

    /// <summary><c>map save</c> — persist the current map to flash.</summary>
    public void MapSave(CancellationToken cancellationToken = default) =>
        Ok("map save", cancellationToken);

    /// <summary><c>map default</c> — reset the RAM map to the default map.</summary>
    public void MapDefault(CancellationToken cancellationToken = default) =>
        Ok("map default", cancellationToken);

    // --- pattern ---

    /// <summary>One <c>pattern add</c> line (atomic on the device). Returns the
    /// total number of steps now in the buffer. The steps must fit one 256-byte
    /// line; use <see cref="PatternLoad"/> for longer patterns.</summary>
    public ushort PatternAdd(
        IReadOnlyList<PatternStep> steps,
        CancellationToken cancellationToken = default)
    {
        var lines = Protocol.PatternAddCommands(steps);
        if (lines.Count != 1)
        {
            throw new SdkException(
                ErrorCode.InvalidArgument,
                $"{steps.Count} steps do not fit one {Protocol.MaxLineBytes}-byte line; "
                    + "use PatternLoad");
        }

        return Query(lines[0], Protocol.ParsePatternTotal, cancellationToken);
    }

    /// <summary><c>pattern reset</c>, then <c>pattern add</c> in as many chunks
    /// as needed, each packed to at most 256 bytes per line. Returns the final
    /// total. All steps are validated before anything is sent.</summary>
    public ushort PatternLoad(
        IReadOnlyList<PatternStep> steps,
        CancellationToken cancellationToken = default)
    {
        var lines = Protocol.PatternAddCommands(steps);
        PatternReset(cancellationToken);
        ushort total = 0;
        foreach (var line in lines)
        {
            total = Query(line, Protocol.ParsePatternTotal, cancellationToken);
        }

        return total;
    }

    /// <summary><c>pattern run</c> — <see cref="PatternMode.Once"/> plays one
    /// pass (the repeat is ignored); <see cref="PatternMode.Loop"/> requires a
    /// repeat of 1-65535. Completion arrives as a <see cref="PatternDoneEvent"/>,
    /// a firmware safety timeout as a <see cref="PatternTimeoutEvent"/>.</summary>
    public void PatternRun(
        PatternMode mode, ushort repeat, CancellationToken cancellationToken = default) =>
        Ok(Protocol.PatternRunCommand(mode, repeat), cancellationToken);

    /// <summary><c>pattern stop</c> — stop playback; the steps stay loaded.
    /// Fails with <see cref="ErrorCode.NotRunning"/> when the engine is not
    /// running.</summary>
    public void PatternStop(CancellationToken cancellationToken = default) =>
        Ok("pattern stop", cancellationToken);

    /// <summary><c>pattern status</c> — current playback status.</summary>
    public PatternStatus PatternStatus(CancellationToken cancellationToken = default) =>
        Query("pattern status", Protocol.ParsePatternStatus, cancellationToken);

    /// <summary><c>pattern reset</c> — abort any run, clear the buffer and
    /// return to idle. USB stays up.</summary>
    public void PatternReset(CancellationToken cancellationToken = default) =>
        Ok("pattern reset", cancellationToken);

    // --- reset ---

    /// <summary><c>reset</c> — reboot the device. USB re-enumerates, so this
    /// connection must be disposed and the device rediscovered. RAM state
    /// returns to defaults; flash state is kept.</summary>
    public void Reset(CancellationToken cancellationToken = default) =>
        Ok("reset", cancellationToken);

    /// <summary><c>bootsel</c> — reboot into BOOTSEL mass-storage mode for UF2
    /// reflash. The connection must be disposed afterwards.</summary>
    public void Bootsel(CancellationToken cancellationToken = default) =>
        Ok("bootsel", cancellationToken);

    // --- timestamp ---

    /// <summary><c>ts arm &lt;mask&gt; &lt;mode&gt;</c> — arm timestamp capture. The
    /// mask must be non-zero and inside the DIO pins.</summary>
    public void TsArm(uint mask, EdgeMode mode, CancellationToken cancellationToken = default) =>
        Ok(Protocol.TsArmCommand(mask, mode), cancellationToken);

    /// <summary><c>ts get &lt;max&gt;</c> — retrieve captured events (counted
    /// read of exactly the announced number of lines). <paramref name="maxEvents"/>
    /// must be 1-85; draining a full ring takes several calls. The result carries
    /// no nanosecond values: use <see cref="TimestampEvent.Ns"/> or
    /// <see cref="Reconciler"/> with <see cref="Capabilities.TsResNs"/>.</summary>
    public TimestampResult TsGet(ushort maxEvents, CancellationToken cancellationToken = default)
    {
        var (data, lines) = _transport.CommandCounted(
            Protocol.TsGetCommand(maxEvents), cancellationToken);
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
    public TsStatus TsStatus(CancellationToken cancellationToken = default) =>
        Query("ts status", Protocol.ParseTsStatus, cancellationToken);

    /// <summary><c>ts disarm</c> — disarm capture and discard buffered events.</summary>
    public void TsDisarm(CancellationToken cancellationToken = default) =>
        Ok("ts disarm", cancellationToken);

    // --- sync ---

    /// <summary><c>sync arm</c> — prepare as slave.</summary>
    public void SyncArm(CancellationToken cancellationToken = default) =>
        Ok("sync arm", cancellationToken);

    /// <summary><c>sync master</c> — prepare as master.</summary>
    public void SyncMaster(CancellationToken cancellationToken = default) =>
        Ok("sync master", cancellationToken);

    /// <summary><c>sync start</c> — start sync pulse + 1 MHz clock (master only).</summary>
    public void SyncStart(CancellationToken cancellationToken = default) =>
        Ok("sync start", cancellationToken);

    /// <summary><c>sync stop</c> — stop clock output (master only).</summary>
    public void SyncStop(CancellationToken cancellationToken = default) =>
        Ok("sync stop", cancellationToken);

    /// <summary><c>sync count</c> — current sync clock count. A single line
    /// (<c>OK clocks=N</c>), not a counted response.</summary>
    public ulong SyncCount(CancellationToken cancellationToken = default) =>
        Query("sync count", Protocol.ParseSyncCount, cancellationToken);

    /// <summary><c>sync disarm</c> — return to idle (always accepted).</summary>
    public void SyncDisarm(CancellationToken cancellationToken = default) =>
        Ok("sync disarm", cancellationToken);

    // --- safety functions ---

    /// <summary><c>wdog &lt;ms&gt;</c> — set the watchdog timeout (0 disables it,
    /// otherwise 100-10000; CDC only). Every <c>OK</c> answer restarts the timer;
    /// when it expires the device sets the failsafe latch and puts the outputs at
    /// their <c>def</c>. With the watchdog on, keep the device busy:
    /// <see cref="StartHeartbeat"/>.</summary>
    public void Wdog(uint ms, CancellationToken cancellationToken = default) =>
        Ok(Protocol.WdogCommand(ms), cancellationToken);

    /// <summary><c>safety</c> — the safety state (watchdog, failsafe latch,
    /// <c>usbsafe</c>, number of exclusive groups). The source of truth for
    /// <see cref="FailsafeEvent"/>.</summary>
    public SafetyState Safety(CancellationToken cancellationToken = default) =>
        Query("safety", Protocol.ParseSafety, cancellationToken);

    /// <summary><c>failsafe clear</c> — release the failsafe latch (CDC only). The
    /// outputs stay where they are and the watchdog timer restarts.</summary>
    public void FailsafeClear(CancellationToken cancellationToken = default) =>
        Ok("failsafe clear", cancellationToken);

    /// <summary><c>outputs reset</c> — put every output at its <c>def</c> (the safe
    /// state) and stop a running pattern. Always succeeds on the device, also with
    /// the latch set.</summary>
    public void OutputsReset(CancellationToken cancellationToken = default) =>
        Ok("outputs reset", cancellationToken);

    /// <summary><c>excl set</c> — replace all exclusive groups atomically: 1 to 16
    /// masks, each a subset of the DIO pins with at least 2 bits (CDC only).
    /// That every pin is an output depends on the active map and is answered by
    /// the device (<see cref="ErrorCode.BadParam"/>).</summary>
    public void ExclSet(IReadOnlyList<uint> masks, CancellationToken cancellationToken = default) =>
        Ok(Protocol.ExclSetCommand(masks), cancellationToken);

    /// <summary><c>excl clear</c> — remove all exclusive groups (CDC only).</summary>
    public void ExclClear(CancellationToken cancellationToken = default) =>
        Ok("excl clear", cancellationToken);

    /// <summary><c>excl get</c> — the exclusive groups in the order they were set
    /// (a counted response; at most 16).</summary>
    public IReadOnlyList<uint> ExclGet(CancellationToken cancellationToken = default)
    {
        var (header, lines) = _transport.CommandCounted("excl get", cancellationToken);
        return Parsed(header, h => Protocol.ParseExclGet(h, lines));
    }

    /// <summary><c>usbsafe on|off</c> — set the failsafe for a lost USB link (CDC only).</summary>
    public void UsbSafe(bool on, CancellationToken cancellationToken = default) =>
        Ok(Protocol.UsbsafeCommand(on), cancellationToken);

    /// <summary><c>rstinfo</c> — cause and time of the last restart.</summary>
    public ResetInfo RstInfo(CancellationToken cancellationToken = default) =>
        Query("rstinfo", Protocol.ParseRstinfo, cancellationToken);

    /// <summary><c>pads</c> — the recorded outputs and the level read back from the pads.</summary>
    public Pads Pads(CancellationToken cancellationToken = default) =>
        Query("pads", Protocol.ParsePads, cancellationToken);

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
    public SafetyState ApplySafety(
        SafetyConfig config,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(config);
        foreach (var command in config.Commands())
        {
            Ok(command, cancellationToken);
        }

        var state = Safety(cancellationToken);
        var groups = ExclGet(cancellationToken);
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
    public IReadOnlyList<string> Raw(string command, CancellationToken cancellationToken = default)
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

        return _transport.Raw(command, cancellationToken);
    }
}
