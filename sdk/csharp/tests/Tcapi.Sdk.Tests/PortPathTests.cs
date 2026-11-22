using Xunit;

namespace Tcapi.Sdk.Tests;

/// <summary>The option that keeps the serial port path out of error text
/// (<see cref="ConnectionOptions.OmitPortPathFromErrors"/>).</summary>
public class PortPathTests
{
    // A path that cannot exist, so opening it fails the same way everywhere.
    private const string MissingPort = "/dev/tcapi-no-such-port-7f3a";

    [Fact]
    public void OpenFailureNamesThePortByDefault()
    {
        var ex = TestHelpers.AssertSdkThrows(ErrorCode.Io, () => Connection.Open(MissingPort));
        Assert.Contains(MissingPort, ex.Message, StringComparison.Ordinal);
        Assert.NotNull(ex.InnerException);
    }

    [Fact]
    public void OpenFailureLeavesThePortOutWhenAsked()
    {
        var options = new ConnectionOptions { OmitPortPathFromErrors = true };
        var ex = TestHelpers.AssertSdkThrows(
            ErrorCode.Io, () => Connection.Open(MissingPort, options));

        Assert.DoesNotContain("tcapi-no-such-port", ex.Message, StringComparison.Ordinal);
        Assert.DoesNotContain("/dev/", ex.Message, StringComparison.Ordinal);
        Assert.Null(ex.InnerException); // the OS message in it names the path
        Assert.DoesNotContain("tcapi-no-such-port", ex.ToString(), StringComparison.Ordinal);
    }

    [Fact]
    public void ProbeFailureErrorLeavesThePortOutWhenAsked()
    {
        var options = new ConnectionOptions { OmitPortPathFromErrors = true };
        Assert.False(Discovery.TryProbe(MissingPort, out _, out var error, options));
        Assert.DoesNotContain("tcapi-no-such-port", error.ToString(), StringComparison.Ordinal);
    }

    [Fact]
    public void TryOpenReportsTheErrorAndNoConnection()
    {
        var options = new ConnectionOptions { OmitPortPathFromErrors = true };
        Assert.False(Connection.TryOpen(MissingPort, out var connection, out var error, options));
        Assert.Null(connection);
        Assert.Equal(ErrorCode.Io, error.Code);
    }

    [Fact]
    public void WriteFailureLeavesThePortOutWhenAsked()
    {
        var port = new FakePort();
        port.OnCommand = _ => port.Feed("OK fw=0.1.3 proto=2");
        var transport = new Transport(port, "/dev/ttyACM7", omitPortPath: true);
        transport.Command("version");

        port.Closed = true; // the next write fails with "port closed"
        var ex = TestHelpers.AssertSdkThrows(
            ErrorCode.Disconnected, () => transport.Command("read"));
        Assert.DoesNotContain("ttyACM7", ex.ToString(), StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("Access to the path '/dev/ttyACM0' is denied.", "/dev/ttyACM0", true,
        "Access to the path '<port>' is denied.")]
    [InlineData("device ttyACM0 busy", "/dev/ttyACM0", true, "device <port> busy")]
    [InlineData("The port 'COM3' does not exist.", "COM3", true, "The port '<port>' does not exist.")]
    [InlineData("Path /DEV/TTYACM0", "/dev/ttyACM0", true, "Path <port>")]
    [InlineData("Access to the path '/dev/ttyACM0' is denied.", "/dev/ttyACM0", false,
        "Access to the path '/dev/ttyACM0' is denied.")]
    [InlineData("nothing to hide", "", true, "nothing to hide")]
    // A short final segment is not scrubbed on its own: it would eat unrelated digits.
    [InlineData("read 1 of 21 bytes on /dev/pts/1 failed", "/dev/pts/1", true,
        "read 1 of 21 bytes on <port> failed")]
    // The final segment is replaced as a whole word only.
    [InlineData("ttyACM0 and ttyACM01 and xttyACM0", "/dev/ttyACM0", true,
        "<port> and ttyACM01 and xttyACM0")]
    public void Scrubber(string text, string path, bool omit, string expected) =>
        Assert.Equal(expected, PortPathScrubber.Scrub(text, path, omit));
}
