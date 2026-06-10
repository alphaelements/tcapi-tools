using System.Globalization;

namespace Pochi.Sdk;

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
    private const int PochiVid = 0x2E8A;
    private const int PochiPid = 0x000A;

    /// <summary>True if the USB descriptor identifies a Pochi-DIO. The
    /// legacy "Tachyon" product string is accepted: devices in the field
    /// may still run pre-rename firmware.</summary>
    public static bool MatchesPochi(int? vid, int? pid, string? product)
    {
        if (vid != PochiVid || pid != PochiPid)
        {
            return false;
        }

        return product is not null
            && (product.StartsWith("Pochi", StringComparison.Ordinal)
                || product.StartsWith("Tachyon", StringComparison.Ordinal));
    }

    /// <summary>List serial port paths whose USB descriptors match a
    /// Pochi-DIO (VID 0x2E8A / PID 0x000A / product "Pochi*", legacy
    /// "Tachyon*"). No ports are opened.</summary>
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
            if (usb is { } info && MatchesPochi(info.Vid, info.Pid, info.Product))
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
        var deviceLink = Path.Combine(ttyDir, "device");
        if (!Directory.Exists(deviceLink))
        {
            return null;
        }

        var resolved = new DirectoryInfo(deviceLink).ResolveLinkTarget(returnFinalTarget: true);
        var current = resolved?.FullName ?? Path.GetFullPath(deviceLink);
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

    /// <summary>Probe one port: open it and query <c>info</c> (best-effort
    /// <c>version</c>).</summary>
    public static DeviceInfo Probe(string portPath)
    {
        using var transport = Transport.Open(portPath);
        var (uid, deviceNumber) = Protocol.ParseInfo(transport.Command("info"));

        // Version is informational; an old or odd firmware should not make
        // the device invisible to discovery.
        string? version;
        try
        {
            version = transport.Command("version")
                .Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries)
                .FirstOrDefault();
        }
        catch (SdkException)
        {
            version = null;
        }

        return new DeviceInfo(uid, deviceNumber, portPath, version);
    }

    /// <summary>Enumerate and probe all connected Pochi-DIO devices,
    /// reporting probe failures alongside successes.</summary>
    public static DiscoveryResult DiscoverDetailed()
    {
        var devices = new List<DeviceInfo>();
        var failures = new List<ProbeFailure>();
        foreach (var port in EnumeratePorts())
        {
            try
            {
                devices.Add(Probe(port));
            }
            catch (SdkException error)
            {
                failures.Add(new ProbeFailure(port, error));
            }
        }

        return new DiscoveryResult(devices, failures);
    }

    /// <summary>Enumerate and probe all connected Pochi-DIO devices.
    /// Convenience wrapper over <see cref="DiscoverDetailed"/> (devices only).</summary>
    public static DeviceInfo[] Discover() => DiscoverDetailed().Devices.ToArray();

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

        throw new SdkException(ErrorCode.NoDevice, $"no Pochi-DIO device with UID {uid}");
    }

    /// <summary>Find the device with the given device number. Duplicate
    /// numbers are a user-configuration conflict (MultipleDevices).</summary>
    public static DeviceInfo FindByDeviceNumber(IReadOnlyList<DeviceInfo> devices, byte n)
    {
        var matches = devices.Where(d => d.DeviceNumber == n).ToList();
        if (matches.Count == 0)
        {
            throw new SdkException(
                ErrorCode.NoDevice, $"no Pochi-DIO device with device number {n}");
        }

        if (matches.Count > 1)
        {
            throw new SdkException(
                ErrorCode.MultipleDevices,
                $"multiple devices with device number {n}; use UID or port");
        }

        return matches[0];
    }

    /// <summary>Select the only device, erroring when there are zero or several.</summary>
    public static DeviceInfo SelectSoleDevice(IReadOnlyList<DeviceInfo> devices)
    {
        if (devices.Count == 0)
        {
            throw new SdkException(ErrorCode.NoDevice, "no Pochi-DIO device found");
        }

        if (devices.Count > 1)
        {
            throw new SdkException(
                ErrorCode.MultipleDevices,
                $"{devices.Count} Pochi-DIO devices found; specify UID, device number, or port");
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
