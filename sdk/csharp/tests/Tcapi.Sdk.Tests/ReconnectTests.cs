using Xunit;

namespace Tcapi.Sdk.Tests;

/// <summary>Reconnecting to a device by UID after it re-enumerated (its port
/// path changed), against an in-memory discovery and fake ports.</summary>
public class ReconnectTests
{
    private const string Uid = "E6614103E7235B2F";
    private static readonly TimeSpan Poll = TimeSpan.FromMilliseconds(10);
    private static readonly TimeSpan Plenty = TimeSpan.FromSeconds(10);

    private static DeviceInfo Dev(string uid, string port) => new(uid, null, port, "0.1.3");

    private static DiscoveryResult Found(params DeviceInfo[] devices) => new(devices, []);

    private static Connection Fake(string port, ConnectionOptions? options, CancellationToken ct) =>
        new ScriptedDevice(_ => null).Connect();

    [Fact]
    public void FindsTheDeviceOnANewPortPath()
    {
        string? openedPort = null;
        using var conn = Connection.ReconnectByUid(
            Uid, Plenty, Poll, null, default,
            (_, _) => Found(Dev("0000000000000001", "/dev/ttyACM0"), Dev(Uid, "/dev/ttyACM5")),
            (port, o, ct) =>
            {
                openedPort = port;
                return Fake(port, o, ct);
            });

        Assert.Equal("/dev/ttyACM5", openedPort);
        Assert.Equal(Uid, conn.Uid);
    }

    [Fact]
    public void UidMatchIgnoresCase()
    {
        using var conn = Connection.ReconnectByUid(
            Uid, Plenty, Poll, null, default,
            (_, _) => Found(Dev(Uid.ToLowerInvariant(), "/dev/ttyACM1")), Fake);
        Assert.Equal(Uid.ToLowerInvariant(), conn.Uid);
    }

    [Fact]
    public void WaitsUntilTheDeviceAppears()
    {
        var scans = 0;
        using var conn = Connection.ReconnectByUid(
            Uid, Plenty, Poll, null, default,
            (_, _) => ++scans < 4 ? Found() : Found(Dev(Uid, "/dev/ttyACM2")), Fake);

        Assert.Equal(4, scans);
        Assert.NotNull(conn);
    }

    [Fact]
    public void RetriesAPortThatIsNotReadyYet()
    {
        var opens = 0;
        using var conn = Connection.ReconnectByUid(
            Uid, Plenty, Poll, null, default,
            (_, _) => Found(Dev(Uid, "/dev/ttyACM2")),
            (port, o, ct) => ++opens < 3
                ? throw new SdkException(ErrorCode.Io, "failed to open serial port: busy")
                : Fake(port, o, ct));

        Assert.Equal(3, opens);
    }

    [Theory]
    [InlineData(ErrorCode.Timeout)]
    [InlineData(ErrorCode.Disconnected)]
    public void RetriesAPortThatTimedOutOrDroppedWhileOpening(ErrorCode code)
    {
        var opens = 0;
        using var conn = Connection.ReconnectByUid(
            Uid, Plenty, Poll, null, default,
            (_, _) => Found(Dev(Uid, "/dev/ttyACM2")),
            (port, o, ct) => ++opens < 2
                ? throw new SdkException(code, "device not ready")
                : Fake(port, o, ct));

        Assert.Equal(2, opens);
    }

    [Fact]
    public void GivesUpAfterTheTimeoutWithNoDevice()
    {
        var ex = TestHelpers.AssertSdkThrows(ErrorCode.NoDevice, () =>
            Connection.ReconnectByUid(
                Uid, TimeSpan.FromMilliseconds(60), Poll, null, default,
                (_, _) => Found(), Fake));
        Assert.Contains(Uid, ex.Message, StringComparison.Ordinal);
        Assert.Contains("60 ms", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ZeroTimeoutMakesOneAttempt()
    {
        var scans = 0;
        TestHelpers.AssertSdkThrows(ErrorCode.NoDevice, () =>
            Connection.ReconnectByUid(
                Uid, TimeSpan.Zero, Poll, null, default, (_, _) => { scans++; return Found(); }, Fake));
        Assert.Equal(1, scans);
    }

    [Fact]
    public void NegativeTimeoutIsRejected() =>
        TestHelpers.AssertSdkThrows(ErrorCode.InvalidArgument, () =>
            Connection.ReconnectByUid(
                Uid, TimeSpan.FromSeconds(-1), Poll, null, default, (_, _) => Found(), Fake));

    [Fact]
    public void TimeoutErrorKeepsTheLastFailureReason()
    {
        var ex = TestHelpers.AssertSdkThrows(ErrorCode.NoDevice, () =>
            Connection.ReconnectByUid(
                Uid, TimeSpan.FromMilliseconds(40), Poll, null, default,
                (_, _) => Found(Dev(Uid, "/dev/ttyACM2")),
                (_, _, _) => throw new SdkException(ErrorCode.Io, "failed to open serial port: busy")));
        Assert.Contains("busy", ex.Message, StringComparison.Ordinal);
        Assert.Equal(ErrorCode.Io, ((SdkException)ex.InnerException!).Code);
    }

    [Fact]
    public void OmittingThePortPathAlsoDropsTheInnerException()
    {
        var options = new ConnectionOptions { OmitPortPathFromErrors = true };
        var ex = TestHelpers.AssertSdkThrows(ErrorCode.NoDevice, () =>
            Connection.ReconnectByUid(
                Uid, TimeSpan.FromMilliseconds(40), Poll, options, default,
                (_, _) => Found(Dev(Uid, "/dev/ttyACM2")),
                (_, _, _) => throw new SdkException(ErrorCode.Io, "failed to open serial port: busy")));
        Assert.Null(ex.InnerException);
    }

    [Fact]
    public void AFailureRetryingCannotFixIsThrownAtOnce()
    {
        var opens = 0;
        TestHelpers.AssertSdkThrows(ErrorCode.UnsupportedFirmware, () =>
            Connection.ReconnectByUid(
                Uid, Plenty, Poll, null, default,
                (_, _) => Found(Dev(Uid, "/dev/ttyACM2")),
                (_, _, _) =>
                {
                    opens++;
                    throw SdkException.UnsupportedFirmware("proto=1");
                }));
        Assert.Equal(1, opens);

        TestHelpers.AssertSdkThrows(ErrorCode.Connection, () =>
            Connection.ReconnectByUid(
                Uid, Plenty, Poll, null, default,
                (_, _) => throw new SdkException(ErrorCode.Connection, "discovery unavailable"),
                Fake));
    }

    [Fact]
    public void CancellationEndsTheWaitPromptly()
    {
        using var cts = new CancellationTokenSource(TimeSpan.FromMilliseconds(80));
        var started = Environment.TickCount64;

        Assert.ThrowsAny<OperationCanceledException>(() =>
            Connection.ReconnectByUid(
                Uid, TimeSpan.FromSeconds(60), TimeSpan.FromSeconds(30), null, cts.Token,
                (_, _) => Found(), Fake));

        Assert.True(Environment.TickCount64 - started < 5000, "the poll sleep ignored the token");
    }

    [Fact]
    public void TryReconnectByUidReportsNoDeviceWithoutThrowing()
    {
        // The real discovery: no Tcapi device here, so the single attempt fails
        // with NoDevice (Linux) or Connection (platform cannot enumerate).
        Assert.False(Connection.TryReconnectByUid(
            Uid, TimeSpan.Zero, out var connection, out var error));
        Assert.Null(connection);
        Assert.Contains(error.Code, new[] { ErrorCode.NoDevice, ErrorCode.Connection });
    }

    // --- Connection.Uid and Connection.Reconnect ---

    [Fact]
    public void UidIsLearnedFromInfo()
    {
        var device = new ScriptedDevice(line =>
            line == "info" ? ["OK uid=E6614103E7235B2F devnum=255"] : null);
        using var conn = device.Connect();
        Assert.Null(conn.Uid);

        conn.Info();

        Assert.Equal(Uid, conn.Uid);
    }

    [Fact]
    public void ReconnectNeedsAKnownUid()
    {
        var device = new ScriptedDevice(_ => null);
        using var conn = device.Connect();
        TestHelpers.AssertSdkThrows(
            ErrorCode.InvalidArgument, () => conn.Reconnect(TimeSpan.Zero));
        Assert.False(conn.IsClosed, "a refused reconnect leaves the connection alone");
    }

    [Fact]
    public void ReconnectClosesTheOldConnectionThenLooksTheDeviceUp()
    {
        var device = new ScriptedDevice(line =>
            line == "info" ? ["OK uid=E6614103E7235B2F devnum=255"] : null);
        var conn = device.Connect();
        conn.Info();

        // No Tcapi device is attached here, so the single attempt ends in
        // NoDevice (Linux) or Connection (platform cannot enumerate).
        var ex = Assert.Throws<SdkException>(() => conn.Reconnect(TimeSpan.Zero));

        Assert.Contains(ex.Code, new[] { ErrorCode.NoDevice, ErrorCode.Connection });
        Assert.True(conn.IsClosed);
    }
}
