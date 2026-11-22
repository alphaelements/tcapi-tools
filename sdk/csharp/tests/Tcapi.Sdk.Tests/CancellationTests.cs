using Xunit;

namespace Tcapi.Sdk.Tests;

/// <summary>Cancellation of commands: a token ends the wait promptly with
/// <see cref="OperationCanceledException"/>, a pre-cancelled token sends
/// nothing, and a command cancelled after it was written leaves the stream out
/// of step so the next operation resynchronises with <c>ping</c>.</summary>
public class CancellationTests
{
    private static readonly TimeSpan LongTimeout = TimeSpan.FromSeconds(30);

    [Fact]
    public void PreCancelledTokenSendsNothing()
    {
        var device = new ScriptedDevice(_ => null);
        using var conn = device.Connect();
        using var cts = new CancellationTokenSource();
        cts.Cancel();

        Assert.ThrowsAny<OperationCanceledException>(() => conn.Read(cts.Token));
        Assert.Empty(device.Commands());
    }

    [Fact]
    public void CancelWhileWaitingForTheAnswerEndsThePendingCommand()
    {
        var device = new ScriptedDevice(line => line == "read" ? [] : null);
        using var conn = device.Connect(LongTimeout);
        using var cts = new CancellationTokenSource(TimeSpan.FromMilliseconds(100));

        var started = Environment.TickCount64;
        Assert.ThrowsAny<OperationCanceledException>(() => conn.Read(cts.Token));

        Assert.True(Environment.TickCount64 - started < 5000, "cancellation was not prompt");
        Assert.Equal(["read"], device.Commands());
    }

    [Fact]
    public void CommandAfterACancelledOneResynchronises()
    {
        var swallow = true;
        var device = new ScriptedDevice(line =>
        {
            if (line == "read" && swallow)
            {
                swallow = false;
                return []; // the first read is never answered
            }

            return line == "read" ? ["OK in=0x00000005"] : null;
        });
        using var conn = device.Connect(LongTimeout);
        using var cts = new CancellationTokenSource(TimeSpan.FromMilliseconds(100));
        Assert.ThrowsAny<OperationCanceledException>(() => conn.Read(cts.Token));

        Assert.Equal(5u, conn.Read());

        var commands = device.Commands();
        Assert.Equal("read", commands[0]);
        Assert.StartsWith("ping ", commands[1], StringComparison.Ordinal);
        Assert.Equal("read", commands[2]);
    }

    [Fact]
    public async Task CancelWhileAnotherCommandHoldsTheConnection()
    {
        var device = new ScriptedDevice(line => line == "read" ? [] : null);
        using var conn = device.Connect(LongTimeout);
        using var firstCts = new CancellationTokenSource();
        var first = Task.Run(() =>
            Assert.ThrowsAny<OperationCanceledException>(() => conn.Read(firstCts.Token)));
        SpinWait.SpinUntil(() => device.Commands().Count == 1, TimeSpan.FromSeconds(5));

        using var secondCts = new CancellationTokenSource(TimeSpan.FromMilliseconds(100));
        Assert.ThrowsAny<OperationCanceledException>(() => conn.State(secondCts.Token));
        Assert.Equal(["read"], device.Commands()); // the second never reached the wire

        firstCts.Cancel();
        await first;
    }

    [Fact]
    public void CountedResponseIsCancellable()
    {
        // Header announces 3 lines, only one arrives: the read is stuck until cancelled.
        var device = new ScriptedDevice(line =>
            line.StartsWith("ts get", StringComparison.Ordinal)
                ? ["OK count=3 overflow=0", "  1 2 3"]
                : null);
        using var conn = device.Connect(LongTimeout);
        using var cts = new CancellationTokenSource(TimeSpan.FromMilliseconds(100));

        Assert.ThrowsAny<OperationCanceledException>(() => conn.TsGet(3, cts.Token));
    }

    [Fact]
    public void TokenThatIsNeverCancelledChangesNothing()
    {
        var device = new ScriptedDevice(line => line == "read" ? ["OK in=0x00000001"] : null);
        using var conn = device.Connect();
        using var cts = new CancellationTokenSource();

        Assert.Equal(1u, conn.Read(cts.Token));
    }

    [Fact]
    public void OpenHandshakeIsCancellable()
    {
        var port = new FakePort(); // never answers `version`
        using var cts = new CancellationTokenSource(TimeSpan.FromMilliseconds(100));

        Assert.ThrowsAny<OperationCanceledException>(
            () => Connection.FromPort(port, cancellationToken: cts.Token));
        Assert.True(port.Closed, "the port is closed when the handshake is cancelled");
    }
}
