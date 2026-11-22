using System.Diagnostics.CodeAnalysis;
using System.Globalization;

namespace Tcapi.Sdk;

/// <summary>A port that matched the USB filter but could not be probed.</summary>
public sealed record ProbeFailure(string Port, SdkException Error);

/// <summary>Full discovery outcome, including ports that failed to respond.
/// Failures are matching ports that could not be opened or probed (e.g.
/// held open by another process). Not fatal for the scan as a whole.</summary>
public sealed record DiscoveryResult(
    IReadOnlyList<DeviceInfo> Devices,
    IReadOnlyList<ProbeFailure> Failures
);

/// <summary>Device discovery: USB enumeration, probing, and selection.
/// Mirrors <c>sdk/rust/src/discovery.rs</c>. Enumeration reads Linux sysfs
/// (System.IO.Ports exposes no USB descriptors); on other platforms it
/// fails loudly instead of silently returning nothing — connect by explicit
/// port path (<see cref="Connection.Open"/>) there.</summary>
public static class Discovery
{
    private const int TcapiVid = 0x2E8A;
    private const int TcapiPid = 0x1175;

    /// <summary>True if the USB descriptor identifies a Tcapi-DIO: VID
    /// 0x2E8A, PID 0x1175 and a product string that starts with "Tcapi". No
    /// other product name is accepted. A port whose OS descriptor has no
    /// product string is not listed here; the <c>version</c> probe is the final
    /// check for the ports that are.</summary>
    public static bool MatchesTcapi(int? vid, int? pid, string? product)
    {
        if (vid != TcapiVid || pid != TcapiPid)
        {
            return false;
        }

        return product is not null && product.StartsWith("Tcapi", StringComparison.Ordinal);
    }

    /// <summary>List serial port paths whose USB descriptors match a
    /// Tcapi-DIO (VID 0x2E8A / PID 0x1175 / product "Tcapi*"). No ports are
    /// opened. Results are sorted by port path:
    /// the OS enumeration order is unspecified, and callers rely on a
    /// deterministic device order.</summary>
    public static IReadOnlyList<string> EnumeratePorts()
    {
        if (!OperatingSystem.IsLinux())
        {
            throw new SdkException(
                ErrorCode.Connection,
                "device discovery is implemented for Linux (sysfs) only; "
                    + "connect by explicit port path instead (Connection.Open)");
        }

        return EnumeratePorts("/sys/class/tty");
    }

    internal static IReadOnlyList<string> EnumeratePorts(string sysClassTty)
    {
        if (!Directory.Exists(sysClassTty))
        {
            return [];
        }

        var ports = new List<string>();
        foreach (var entry in Directory.GetDirectories(sysClassTty)
                     .OrderBy(p => p, StringComparer.Ordinal))
        {
            var usb = TryReadUsbInfo(entry);
            if (usb is { } info && MatchesTcapi(info.Vid, info.Pid, info.Product))
            {
                ports.Add("/dev/" + Path.GetFileName(entry));
            }
        }

        return ports;
    }

    /// <summary>Resolve a sysfs tty entry to its USB device descriptors by
    /// walking up from the <c>device</c> link to the directory that holds
    /// <c>idVendor</c>/<c>idProduct</c>. Returns null for non-USB ttys.</summary>
    private static (int Vid, int Pid, string? Product)? TryReadUsbInfo(string ttyDir)
    {
        // /sys/class/tty entries are themselves symlinks into /sys/devices,
        // and the `device` link below them is a relative symlink. Resolve the
        // class entry to its real path first: a relative target resolved
        // against the un-dereferenced class path points outside the tree.
        var realTtyDir = ResolveDirLink(ttyDir);
        var deviceLink = Path.Combine(realTtyDir, "device");
        if (!Directory.Exists(deviceLink))
        {
            return null;
        }

        var current = ResolveDirLink(deviceLink);
        for (var depth = 0; depth < 6 && current is not null;
             depth++, current = Path.GetDirectoryName(current))
        {
            var vidPath = Path.Combine(current, "idVendor");
            var pidPath = Path.Combine(current, "idProduct");
            if (!File.Exists(vidPath) || !File.Exists(pidPath))
            {
                continue;
            }

            if (!int.TryParse(File.ReadAllText(vidPath).Trim(), NumberStyles.HexNumber,
                    CultureInfo.InvariantCulture, out var vid)
                || !int.TryParse(File.ReadAllText(pidPath).Trim(), NumberStyles.HexNumber,
                    CultureInfo.InvariantCulture, out var pid))
            {
                return null;
            }

            var productPath = Path.Combine(current, "product");
            var product = File.Exists(productPath)
                ? File.ReadAllText(productPath).Trim()
                : null;
            return (vid, pid, product);
        }

        return null;
    }

    /// <summary>Fully resolve a directory path that may be (or end in) a
    /// symlink, normalizing any <c>..</c> components against real
    /// directories.</summary>
    private static string ResolveDirLink(string path)
    {
        var resolved = new DirectoryInfo(path).ResolveLinkTarget(returnFinalTarget: true);
        return Path.GetFullPath(resolved?.FullName ?? path);
    }

    /// <summary>Probe one port: open it (DTR asserted), require <c>version</c>
    /// to report <c>proto=2</c>, then query <c>info</c>. A device on another
    /// protocol fails with <see cref="ErrorCode.UnsupportedFirmware"/> and is
    /// reported among the failures, never listed as usable.</summary>
    public static DeviceInfo Probe(
        string portPath,
        ConnectionOptions? options = null,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        using var transport = Transport.Open(
            portPath, (options ?? ConnectionOptions.Default).OmitPortPathFromErrors);
        return Probe(transport, portPath, cancellationToken);
    }

    /// <summary><see cref="Probe(string, ConnectionOptions?, CancellationToken)"/>
    /// without throwing for an error of the port or the device: the
    /// <see cref="SdkException"/> is returned instead. A cancellation still
    /// throws <see cref="OperationCanceledException"/>.</summary>
    public static bool TryProbe(
        string portPath,
        [NotNullWhen(true)] out DeviceInfo? device,
        [NotNullWhen(false)] out SdkException? error,
        ConnectionOptions? options = null,
        CancellationToken cancellationToken = default) =>
        SdkResult.TryInvoke(
            () => Probe(portPath, options, cancellationToken), out device, out error);

    internal static DeviceInfo Probe(
        Transport transport, string portPath, CancellationToken cancellationToken = default)
    {
        var firmware = Connection.RequireProto(transport, cancellationToken);
        var data = transport.Command("info", cancellationToken);
        try
        {
            var (uid, deviceNumber) = Protocol.ParseInfo(data);
            return new DeviceInfo(
                uid, deviceNumber, portPath,
                $"{firmware.Major}.{firmware.Minor}.{firmware.Patch}");
        }
        catch (SdkException ex) when (ex.Code == ErrorCode.Parse)
        {
            transport.MarkDesync();
            throw;
        }
    }

    /// <summary>Enumerate and probe all connected Tcapi-DIO devices,
    /// reporting probe failures alongside successes.</summary>
    public static DiscoveryResult DiscoverDetailed(
        ConnectionOptions? options = null, CancellationToken cancellationToken = default)
    {
        var devices = new List<DeviceInfo>();
        var failures = new List<ProbeFailure>();
        foreach (var port in EnumeratePorts())
        {
            cancellationToken.ThrowIfCancellationRequested();
            try
            {
                devices.Add(Probe(port, options, cancellationToken));
            }
            catch (SdkException error)
            {
                failures.Add(new ProbeFailure(port, error));
            }
        }

        return new DiscoveryResult(devices, failures);
    }

    /// <summary>Enumerate and probe all connected Tcapi-DIO devices.
    /// Convenience wrapper over <see cref="DiscoverDetailed"/> (devices only).</summary>
    public static DeviceInfo[] Discover(
        ConnectionOptions? options = null, CancellationToken cancellationToken = default) =>
        DiscoverDetailed(options, cancellationToken).Devices.ToArray();

    /// <summary>Find the device with the given UID (case-insensitive).</summary>
    public static DeviceInfo FindByUid(IReadOnlyList<DeviceInfo> devices, string uid)
    {
        foreach (var device in devices)
        {
            if (string.Equals(device.Uid, uid, StringComparison.OrdinalIgnoreCase))
            {
                return device;
            }
        }

        throw new SdkException(ErrorCode.NoDevice, $"no Tcapi-DIO device with UID {uid}");
    }

    /// <summary><see cref="FindByUid"/> as a result: false and the
    /// <see cref="ErrorCode.NoDevice"/> error when no device has the UID.</summary>
    public static bool TryFindByUid(
        IReadOnlyList<DeviceInfo> devices,
        string uid,
        [NotNullWhen(true)] out DeviceInfo? device,
        [NotNullWhen(false)] out SdkException? error) =>
        SdkResult.TryInvoke(() => FindByUid(devices, uid), out device, out error);

    /// <summary>Find the device with the given device number. Duplicate
    /// numbers are a user-configuration conflict (MultipleDevices).</summary>
    public static DeviceInfo FindByDeviceNumber(IReadOnlyList<DeviceInfo> devices, byte n)
    {
        var matches = devices.Where(d => d.DeviceNumber == n).ToList();
        if (matches.Count == 0)
        {
            throw new SdkException(
                ErrorCode.NoDevice, $"no Tcapi-DIO device with device number {n}");
        }

        if (matches.Count > 1)
        {
            throw new SdkException(
                ErrorCode.MultipleDevices,
                $"multiple devices with device number {n}; use UID or port");
        }

        return matches[0];
    }

    /// <summary><see cref="FindByDeviceNumber"/> as a result: false with
    /// <see cref="ErrorCode.NoDevice"/> or <see cref="ErrorCode.MultipleDevices"/>.</summary>
    public static bool TryFindByDeviceNumber(
        IReadOnlyList<DeviceInfo> devices,
        byte n,
        [NotNullWhen(true)] out DeviceInfo? device,
        [NotNullWhen(false)] out SdkException? error) =>
        SdkResult.TryInvoke(() => FindByDeviceNumber(devices, n), out device, out error);

    /// <summary><see cref="SelectSoleDevice"/> as a result: false with
    /// <see cref="ErrorCode.NoDevice"/> or <see cref="ErrorCode.MultipleDevices"/>.</summary>
    public static bool TrySelectSoleDevice(
        IReadOnlyList<DeviceInfo> devices,
        [NotNullWhen(true)] out DeviceInfo? device,
        [NotNullWhen(false)] out SdkException? error) =>
        SdkResult.TryInvoke(() => SelectSoleDevice(devices), out device, out error);

    /// <summary>Select the only device, erroring when there are zero or several.</summary>
    public static DeviceInfo SelectSoleDevice(IReadOnlyList<DeviceInfo> devices)
    {
        if (devices.Count == 0)
        {
            throw new SdkException(ErrorCode.NoDevice, "no Tcapi-DIO device found");
        }

        if (devices.Count > 1)
        {
            throw new SdkException(
                ErrorCode.MultipleDevices,
                $"{devices.Count} Tcapi-DIO devices found; specify UID, device number, or port");
        }

        return devices[0];
    }

    /// <summary>Device numbers assigned to more than one device.</summary>
    public static IReadOnlyList<byte> FindDuplicateNumbers(IReadOnlyList<DeviceInfo> devices)
    {
        var seen = new Dictionary<byte, int>();
        var duplicates = new List<byte>();
        foreach (var device in devices)
        {
            if (device.DeviceNumber is not { } number)
            {
                continue;
            }

            var count = seen.GetValueOrDefault(number) + 1;
            seen[number] = count;
            if (count == 2)
            {
                duplicates.Add(number);
            }
        }

        return duplicates;
    }
}
