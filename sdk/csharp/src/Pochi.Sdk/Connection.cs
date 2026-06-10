namespace Pochi.Sdk;

/// <summary>High-level typed connection to one Pochi-DIO device.
/// Mirrors <c>sdk/rust/src/connection.rs</c>. Push events are delivered via
/// <see cref="Events"/> on the transport reader thread; the connection is
/// <see cref="IDisposable"/> and closes the port on dispose.</summary>
public sealed class Connection : IDisposable
{
    private readonly Transport _transport;
    private readonly string _portPath;
    private readonly PushEventSource _events = new();

    private Connection(Transport transport, string portPath)
    {
        _transport = transport;
        _portPath = portPath;
        _transport.SetEventCallback(_events.Publish);
    }

    // --- constructors ---

    /// <summary>Open a connection to the device at the given serial port path.</summary>
    public static Connection Open(string port) => new(Transport.Open(port), port);

    /// <summary>Discover devices and connect to the one with the given UID.</summary>
    public static Connection OpenByUid(string uid) =>
        Open(Discovery.FindByUid(Discovery.Discover(), uid).Port);

    /// <summary>Discover devices and connect by device number.</summary>
    public static Connection OpenByDeviceNumber(byte n) =>
        Open(Discovery.FindByDeviceNumber(Discovery.Discover(), n).Port);

    /// <summary>Discover devices and connect to the sole connected device.</summary>
    public static Connection OpenSoleDevice() =>
        Open(Discovery.SelectSoleDevice(Discovery.Discover()).Port);

    /// <summary>Wrap an already-open port (fake-port tests, custom transports).</summary>
    public static Connection FromPort(IDuplexPort port) => new(new Transport(port), "");

    // --- lifecycle ---

    /// <summary>Command response timeout (default 2 seconds).</summary>
    public TimeSpan CommandTimeout
    {
        get => _transport.CommandTimeout;
        set => _transport.CommandTimeout = value;
    }

    /// <summary>Push events (<c>! ...</c> lines), delivered on the reader
    /// thread, including while commands are in flight. Subscribing after
    /// close completes immediately.</summary>
    public IObservable<PushEvent> Events => _events;

    /// <summary>Close the connection.</summary>
    public void Close()
    {
        _transport.Close();
        _events.Complete();
    }

    public void Dispose() => Close();

    // --- device information ---

    /// <summary><c>version</c> — firmware and protocol version.</summary>
    public VersionInfo Version() => Protocol.ParseVersion(_transport.Command("version"));

    /// <summary><c>caps</c> — device capabilities (protocol version filled in
    /// from <c>version</c>). Throws UnsupportedFirmware on pre-9.6 FW.</summary>
    public Capabilities Caps()
    {
        var caps = Protocol.ParseCaps(_transport.Command("caps"));
        return caps with { ProtocolVersion = Version().ProtocolVersion };
    }

    /// <summary><c>info</c> — device identification (UID, device number).</summary>
    public DeviceInfo Info()
    {
        var (uid, deviceNumber) = Protocol.ParseInfo(_transport.Command("info"));
        return new DeviceInfo(uid, deviceNumber, _portPath, null);
    }

    /// <summary><c>devnum &lt;n&gt;</c> — set the device number (0-254; 255 unassigns).</summary>
    public void SetDeviceNumber(byte n) => _transport.Command($"devnum {n}");

    // --- digital I/O ---

    /// <summary><c>read</c> — current input values.</summary>
    public uint Read() => Protocol.ParseRead(_transport.Command("read"));

    /// <summary><c>write &lt;values&gt; &lt;mask&gt;</c> — set outputs (masked bits only).</summary>
    public void Write(uint values, uint mask) =>
        _transport.Command($"write 0x{values:x} 0x{mask:x}");

    /// <summary><c>state</c> — complete I/O state.</summary>
    public IoState State() => Protocol.ParseState(_transport.Command("state"));

    // --- pin map ---

    /// <summary><c>map get</c> — current pin map.</summary>
    public PinMap MapGet() => Protocol.ParseMap(_transport.Command("map get"));

    /// <summary><c>map set</c> from a typed PinMap (extended fields zero).</summary>
    public void MapSet(PinMap pinMap) => MapSetHex(Protocol.MapToHex(pinMap));

    /// <summary><c>map set &lt;hex&gt;</c> — raw 48-char hex map.</summary>
    public void MapSetHex(string hex) => _transport.Command($"map set {hex}");

    /// <summary><c>map save</c> — persist the current map to flash.</summary>
    public void MapSave() => _transport.Command("map save");

    /// <summary><c>map default</c> — reset to the default map (all inputs).</summary>
    public void MapDefault() => _transport.Command("map default");

    // --- pattern ---

    /// <summary><c>pattern load</c> from typed steps. Returns accepted count.</summary>
    public ushort PatternLoad(IReadOnlyList<PatternStep> steps) =>
        PatternLoadHex(Protocol.PatternToHex(steps));

    /// <summary><c>pattern load &lt;hex&gt;</c> — raw count-prefixed step data.</summary>
    public ushort PatternLoadHex(string hex) =>
        Protocol.ParseAccepted(_transport.Command($"pattern load {hex}"));

    /// <summary><c>pattern run &lt;mode&gt; &lt;repeat&gt;</c> — start playback. Note:
    /// <c>loop</c> with repeat=0 is rejected by FW (no infinite mode).</summary>
    public void PatternRun(PatternMode mode, ushort repeat) =>
        _transport.Command(Protocol.PatternRunCommand(mode, repeat));

    /// <summary><c>pattern stop</c> — stop playback immediately.</summary>
    public void PatternStop() => _transport.Command("pattern stop");

    /// <summary><c>pattern status</c> — current playback status.</summary>
    public PatternStatus PatternStatus() =>
        Protocol.ParsePatternStatus(_transport.Command("pattern status"));

    // --- timestamp ---

    /// <summary><c>ts arm &lt;mask&gt; &lt;mode&gt;</c> — arm timestamp capture.</summary>
    public void TsArm(uint mask, EdgeMode mode) =>
        _transport.Command(Protocol.TsArmCommand(mask, mode));

    /// <summary><c>ts get &lt;max&gt;</c> — retrieve captured events (counted
    /// read). TimestampNs is the host-computed as-is value; apply
    /// <see cref="Reconciler"/> for straddle correction across events.</summary>
    public TimestampResult TsGet(ushort maxEvents)
    {
        var (_, lines) = _transport.CommandCounted($"ts get {maxEvents}");
        return new TimestampResult(
            lines.Select(Protocol.ParseTsEventLine).ToArray(),
            Reconciled: false
        );
    }

    /// <summary><c>ts disarm</c> — disarm capture and discard buffered events.</summary>
    public void TsDisarm() => _transport.Command("ts disarm");

    // --- events ---

    /// <summary><c>subscribe on|off</c> — toggle input change push notifications.</summary>
    public void Subscribe(bool enable) =>
        _transport.Command(enable ? "subscribe on" : "subscribe off");

    // --- sync ---

    /// <summary><c>sync arm</c> — prepare as slave.</summary>
    public void SyncArm() => _transport.Command("sync arm");

    /// <summary><c>sync master</c> — prepare as master.</summary>
    public void SyncMaster() => _transport.Command("sync master");

    /// <summary><c>sync start</c> — start sync pulse + 1 MHz clock (master only).</summary>
    public void SyncStart() => _transport.Command("sync start");

    /// <summary><c>sync stop</c> — stop clock output (master only).</summary>
    public void SyncStop() => _transport.Command("sync stop");

    /// <summary><c>sync count</c> — current sync clock count. Single-line
    /// response (<c>OK count=N</c>, no data lines) — plain read path, never
    /// counted.</summary>
    public ulong SyncCount() => Protocol.ParseSyncCount(_transport.Command("sync count"));

    /// <summary><c>sync disarm</c> — release sync state (safe in any state).</summary>
    public void SyncDisarm() => _transport.Command("sync disarm");

    // --- escape hatch ---

    /// <summary>Send an arbitrary command, returning the raw response line.</summary>
    public string Raw(string command) => _transport.Raw(command);
}
