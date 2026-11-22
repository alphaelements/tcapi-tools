using Xunit;

namespace Tcapi.Sdk.Tests;

/// <summary>Result-style API: <c>TryXxx(..., out value, out error)</c> for the
/// operations whose failure is an expected branch, and
/// <see cref="Connection.Try{T}"/> / <see cref="SdkResult"/> for any command.</summary>
public class ResultApiTests
{
    private static readonly DeviceInfo A = new("AAAA000000000001", 1, "/dev/ttyACM0", "0.1.3");
    private static readonly DeviceInfo B = new("BBBB000000000002", 1, "/dev/ttyACM1", "0.1.3");

    // --- Connection.Try ---

    [Fact]
    public void TryReturnsTheValue()
    {
        var device = new ScriptedDevice(line => line == "read" ? ["OK in=0x00000005"] : null);
        using var conn = device.Connect();

        var result = conn.Try(c => c.Read());

        Assert.True(result.IsOk);
        Assert.Null(result.Error);
        Assert.Equal(5u, result.Value);
        Assert.True(result.TryGetValue(out var value));
        Assert.Equal(5u, value);
    }

    [Fact]
    public void TryReturnsTheDeviceErrorInsteadOfThrowing()
    {
        var device = new ScriptedDevice(line => line == "pattern stop" ? ["ERR NOT_RUNNING"] : null);
        using var conn = device.Connect();

        var result = conn.Try(c => c.PatternStop());

        Assert.False(result.IsOk);
        Assert.Equal(ErrorCode.NotRunning, result.Error!.Code);
        Assert.Same(result.Error, Assert.Throws<SdkException>(result.ThrowIfError));
    }

    [Fact]
    public void ValueOfAFailedResultThrowsTheError()
    {
        var device = new ScriptedDevice(line => line == "read" ? ["ERR BUSY"] : null);
        using var conn = device.Connect();

        var result = conn.Try(c => c.Read());

        Assert.False(result.TryGetValue(out _));
        Assert.Equal(ErrorCode.Busy, Assert.Throws<SdkException>(() => result.Value).Code);
    }

    [Fact]
    public void TryDoesNotSwallowCancellation()
    {
        var device = new ScriptedDevice(_ => null);
        using var conn = device.Connect();
        using var cts = new CancellationTokenSource();
        cts.Cancel();

        Assert.ThrowsAny<OperationCanceledException>(() => conn.Try(c => c.Read(cts.Token)));
    }

    [Fact]
    public void TryDoesNotSwallowCallerBugs()
    {
        var device = new ScriptedDevice(_ => null);
        using var conn = device.Connect();

        Assert.Throws<ArgumentNullException>(() => conn.Try<uint>(null!));
        Assert.Throws<InvalidOperationException>(
            () => conn.Try<uint>(_ => throw new InvalidOperationException("bug")));
    }

    [Fact]
    public void CaptureOfAnActionAndOfAFunction()
    {
        Assert.True(SdkResult.Capture(() => { }).IsOk);
        var failed = SdkResult.Capture(
            () => throw new SdkException(ErrorCode.Timeout, "slow"));
        Assert.Equal(ErrorCode.Timeout, failed.Error!.Code);
        Assert.Equal(3, SdkResult.Capture(() => 3).Value);
        Assert.False(SdkResult.Capture<int>(
            () => throw new SdkException(ErrorCode.Io, "x")).IsOk);
    }

    [Fact]
    public void FailRequiresAnError()
    {
        Assert.Throws<ArgumentNullException>(() => SdkResult.Fail(null!));
        Assert.Throws<ArgumentNullException>(() => SdkResult<int>.Fail(null!));
    }

    // --- Discovery selection ---

    [Fact]
    public void TryFindByUid()
    {
        Assert.True(Discovery.TryFindByUid([A, B], "bbbb000000000002", out var device, out var error));
        Assert.Equal(B, device);
        Assert.Null(error);

        Assert.False(Discovery.TryFindByUid([A], "CCCC", out device, out error));
        Assert.Null(device);
        Assert.Equal(ErrorCode.NoDevice, error.Code);
    }

    [Fact]
    public void TryFindByDeviceNumberDistinguishesNoneFromDuplicates()
    {
        Assert.False(Discovery.TryFindByDeviceNumber([A], 9, out _, out var none));
        Assert.Equal(ErrorCode.NoDevice, none.Code);
        Assert.False(Discovery.TryFindByDeviceNumber([A, B], 1, out _, out var many));
        Assert.Equal(ErrorCode.MultipleDevices, many.Code);
        Assert.True(Discovery.TryFindByDeviceNumber([A], 1, out var found, out _));
        Assert.Equal(A, found);
    }

    [Fact]
    public void TrySelectSoleDevice()
    {
        Assert.True(Discovery.TrySelectSoleDevice([A], out var sole, out _));
        Assert.Equal(A, sole);
        Assert.False(Discovery.TrySelectSoleDevice([], out _, out var none));
        Assert.Equal(ErrorCode.NoDevice, none.Code);
        Assert.False(Discovery.TrySelectSoleDevice([A, B], out _, out var many));
        Assert.Equal(ErrorCode.MultipleDevices, many.Code);
    }

    // --- Config ---

    [Fact]
    public void TryParseSafety()
    {
        Assert.True(Config.TryParseSafety(
            "version = 2\n[watchdog]\ntimeout_ms = 500\n", "safety.toml", out var config, out var none));
        Assert.Equal(500u, config!.WatchdogMs);
        Assert.Null(none);

        Assert.False(Config.TryParseSafety("version = 3\n", "safety.toml", out config, out var error));
        Assert.Null(config);
        Assert.IsType<ConfigException>(error);
    }

    [Fact]
    public void TryLoadSafetyReportsAMissingFile()
    {
        var path = Path.Combine(Path.GetTempPath(), $"tcapi-missing-{Guid.NewGuid():N}.toml");
        Assert.False(Config.TryLoadSafety(path, out var config, out var error));
        Assert.Null(config);
        Assert.Equal(ErrorCode.Io, error.Code);
    }

    // --- Open ---

    [Fact]
    public void TryOpenSoleDeviceNeedsAPlatformThatCanEnumerate()
    {
        // On Linux the scan runs (and finds no Tcapi device in a test
        // environment); elsewhere discovery is refused. Either way: no throw.
        var ok = Connection.TryOpenSoleDevice(out var connection, out var error);
        connection?.Dispose();
        if (!ok)
        {
            Assert.Contains(error!.Code, new[] { ErrorCode.NoDevice, ErrorCode.Connection });
        }
    }
}
