using Xunit;

namespace Tcapi.Sdk.Tests;

public class MatchesTcapiTests
{
    [Theory]
    [InlineData(0x2E8A, 0x1175, "Tcapi-DIO", true)]
    [InlineData(0x2E8A, 0x1175, "Tcapi", true)]
    [InlineData(0x2E8A, 0x1175, "tcapi-dio", false)] // the prefix is case-sensitive
    [InlineData(0x2E8A, 0x1175, "My Tcapi-DIO", false)] // a prefix, not a substring
    [InlineData(0x2E8A, 0x1175, "Picotool", false)]
    [InlineData(0x2E8A, 0x1175, "", false)]
    [InlineData(0x2E8A, 0x000C, "Tcapi-DIO", false)] // Debugprobe PID
    [InlineData(0x1234, 0x1175, "Tcapi-DIO", false)]
    [InlineData(0x2E8A, 0x1175, null, false)]
    public void Filter(int? vid, int? pid, string? product, bool expected) =>
        Assert.Equal(expected, Discovery.MatchesTcapi(vid, pid, product));
}

public class SysfsEnumerationTests : IDisposable
{
    private readonly string _root;

    public SysfsEnumerationTests()
    {
        _root = Path.Combine(Path.GetTempPath(), $"tcapi-sysfs-{Guid.NewGuid():N}");
    }

    public void Dispose()
    {
        if (Directory.Exists(_root))
        {
            Directory.Delete(_root, recursive: true);
        }
    }

    private void AddTty(string name, string? vid, string? pid, string? product)
    {
        // Layout mirrors real sysfs, including its symlink shape: the
        // class/tty/<name> entry is itself a relative symlink into
        // devices/..., and the `device` link inside the real tty dir is a
        // relative symlink to the USB interface dir whose parent holds
        // idVendor / idProduct / product. Absolute links here would hide
        // resolution bugs that only real sysfs exhibits.
        var usbDevice = Path.Combine(_root, "devices", "usb1", name);
        var realTtyDir = Path.Combine(usbDevice, $"{name}:1.0", "tty", name);
        Directory.CreateDirectory(realTtyDir);
        if (vid is not null)
        {
            File.WriteAllText(Path.Combine(usbDevice, "idVendor"), vid + "\n");
        }

        if (pid is not null)
        {
            File.WriteAllText(Path.Combine(usbDevice, "idProduct"), pid + "\n");
        }

        if (product is not null)
        {
            File.WriteAllText(Path.Combine(usbDevice, "product"), product + "\n");
        }

        Directory.CreateSymbolicLink(
            Path.Combine(realTtyDir, "device"), $"../../../{name}:1.0");
        Directory.CreateDirectory(Path.Combine(_root, "class", "tty"));
        Directory.CreateSymbolicLink(
            Path.Combine(_root, "class", "tty", name),
            $"../../devices/usb1/{name}/{name}:1.0/tty/{name}");
    }

    private void AddBareTty(string name)
    {
        Directory.CreateDirectory(Path.Combine(_root, "class", "tty", name));
    }

    [Fact]
    public void FindsTcapiAndIgnoresOthers()
    {
        AddTty("ttyACM0", "2e8a", "1175", "Tcapi-DIO");
        AddTty("ttyACM1", "2e8a", "1175", "Tcapi-DIO v2");
        AddTty("ttyACM2", "2e8a", "000c", "Debugprobe (CMSIS-DAP)");
        AddTty("ttyACM4", "2e8a", "1175", "Picotool");
        AddTty("ttyUSB0", "0403", "6001", "FT232R USB UART");
        AddBareTty("ttyS0"); // non-USB tty: no device link
        AddTty("ttyACM3", "2e8a", "1175", null); // no product string

        var ports = Discovery.EnumeratePorts(Path.Combine(_root, "class", "tty"));
        Assert.Equal(["/dev/ttyACM0", "/dev/ttyACM1"], ports);
    }

    [Fact]
    public void MissingRootYieldsEmpty() =>
        Assert.Empty(Discovery.EnumeratePorts(Path.Combine(_root, "missing")));
}

public class SelectionTests
{
    private static DeviceInfo Dev(string uid, byte? number, string port) =>
        new(Uid: uid, DeviceNumber: number, Port: port, Version: "v0.1.0");

    [Fact]
    public void FindByUidIsCaseInsensitive()
    {
        var devices = new[] { Dev("AABBCC", 1, "/dev/ttyACM0") };
        Assert.Equal(devices[0], Discovery.FindByUid(devices, "aabbcc"));
        TestHelpers.AssertSdkThrows(ErrorCode.NoDevice,
            () => Discovery.FindByUid(devices, "FFFFFF"));
    }

    [Fact]
    public void FindByDeviceNumber()
    {
        var devices = new[]
        {
            Dev("A", 1, "/dev/ttyACM0"),
            Dev("B", 2, "/dev/ttyACM1"),
            Dev("C", 2, "/dev/ttyACM2"),
            Dev("D", null, "/dev/ttyACM3"),
        };
        Assert.Equal(devices[0], Discovery.FindByDeviceNumber(devices, 1));
        TestHelpers.AssertSdkThrows(ErrorCode.NoDevice,
            () => Discovery.FindByDeviceNumber(devices, 9));
        TestHelpers.AssertSdkThrows(ErrorCode.MultipleDevices,
            () => Discovery.FindByDeviceNumber(devices, 2));
    }

    [Fact]
    public void SelectSoleDevice()
    {
        var sole = new[] { Dev("A", 1, "/dev/ttyACM0") };
        Assert.Equal(sole[0], Discovery.SelectSoleDevice(sole));
        TestHelpers.AssertSdkThrows(ErrorCode.NoDevice,
            () => Discovery.SelectSoleDevice([]));
        TestHelpers.AssertSdkThrows(ErrorCode.MultipleDevices,
            () => Discovery.SelectSoleDevice(
                [Dev("A", 1, "/dev/ttyACM0"), Dev("B", 2, "/dev/ttyACM1")]));
    }

    [Fact]
    public void FindDuplicateNumbers()
    {
        var devices = new[]
        {
            Dev("A", 1, "p0"),
            Dev("B", 2, "p1"),
            Dev("C", 2, "p2"),
            Dev("D", null, "p3"),
            Dev("E", null, "p4"),
            Dev("F", 2, "p5"),
        };
        Assert.Equal([(byte)2], Discovery.FindDuplicateNumbers(devices));
    }
}

public class ProbeTests
{
    /// <summary>A device that answers every request with the response the
    /// golden transcripts record for it; <paramref name="overrides"/> replace
    /// single responses (negative tests).</summary>
    private static FakePort Device(Dictionary<string, string>? overrides = null)
    {
        var port = new FakePort();
        port.OnCommand = line =>
        {
            if (overrides is not null && overrides.TryGetValue(line, out var answer))
            {
                port.Feed(answer);
            }
            else
            {
                port.Feed(GoldenCorpus.FirstResponse(line).ToArray());
            }
        };
        return port;
    }

    [Fact]
    public void ProbeReportsUidDeviceNumberAndFirmwareVersion()
    {
        var port = Device();
        using var transport = new Transport(port);
        var info = Discovery.Probe(transport, "/dev/ttyACM9");
        Assert.Equal(new DeviceInfo("0000000000000000", null, "/dev/ttyACM9", "0.1.3"), info);
        Assert.Equal(["version", "info"], port.Written);
    }

    [Theory]
    [InlineData("OK fw=0.1.3 proto=3")]
    [InlineData("OK fw=0.1.3 proto=0")]
    [InlineData("OK v0.1.0 proto=7")] // legacy line shape on another protocol
    [Trait("Category", "Negative")]
    public void ProbeRefusesAnotherProtocolBeforeAskingForInfo(string version)
    {
        var port = Device(new() { ["version"] = version });
        using var transport = new Transport(port);
        TestHelpers.AssertSdkThrows(
            ErrorCode.UnsupportedFirmware, () => Discovery.Probe(transport, "/dev/ttyACM9"));
        Assert.Equal(["version"], port.Written);
    }

    [Fact]
    [Trait("Category", "Negative")]
    public void ProbeOfAnUnreadableVersionLineIsAParseError()
    {
        var port = Device(new() { ["version"] = "OK nonsense" });
        using var transport = new Transport(port);
        TestHelpers.AssertSdkThrows(
            ErrorCode.Parse, () => Discovery.Probe(transport, "/dev/ttyACM9"));
    }

    [Fact]
    [Trait("Category", "Negative")]
    public void ProbeOfAMalformedInfoIsAParseError()
    {
        var port = Device(new() { ["info"] = "OK uid=short devnum=1" });
        using var transport = new Transport(port);
        TestHelpers.AssertSdkThrows(
            ErrorCode.Parse, () => Discovery.Probe(transport, "/dev/ttyACM9"));
    }
}
