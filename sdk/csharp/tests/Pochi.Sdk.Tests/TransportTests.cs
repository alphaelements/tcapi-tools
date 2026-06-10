using System.Diagnostics;
using Xunit;

namespace Pochi.Sdk.Tests;

public class TransportTests : IDisposable
{
    private readonly FakePort _port = new();
    private readonly Transport _transport;

    public TransportTests()
    {
        _transport = new Transport(_port);
    }

    public void Dispose() => _port.Closed = true;

    private static void WaitFor(Func<bool> condition)
    {
        var deadline = Environment.TickCount64 + 1000;
        while (!condition() && Environment.TickCount64 < deadline)
        {
            Thread.Sleep(10);
        }
    }

    [Fact]
    public void CommandOk()
    {
        _port.OnCommand = _ => _port.Feed("OK v0.1.0 proto=1");
        Assert.Equal("v0.1.0 proto=1", _transport.Command("version"));
        Assert.Equal(["version"], _port.Written);
    }

    [Fact]
    public void CommandDeviceError()
    {
        _port.OnCommand = _ => _port.Feed("ERR UNKNOWN_CMD");
        TestHelpers.AssertSdkThrows(ErrorCode.BadCommand, () => _transport.Command("bogus"));
    }

    [Fact]
    public void CommandGarbageIsParseError()
    {
        _port.OnCommand = _ => _port.Feed("WHAT IS THIS");
        TestHelpers.AssertSdkThrows(ErrorCode.Parse, () => _transport.Command("version"));
    }

    [Fact]
    public void CommandTimeout()
    {
        _transport.CommandTimeout = TimeSpan.FromMilliseconds(150);
        TestHelpers.AssertSdkThrows(ErrorCode.Timeout, () => _transport.Command("version"));
    }

    [Fact]
    public void PushInterleaved()
    {
        var events = new List<PushEvent>();
        _transport.SetEventCallback(ev =>
        {
            lock (events)
            {
                events.Add(ev);
            }
        });
        _port.OnCommand = _ => _port.Feed("! INPUT 0x000005 t=111", "OK 0x000003");
        Assert.Equal("0x000003", _transport.Command("read"));
        WaitFor(() =>
        {
            lock (events)
            {
                return events.Count > 0;
            }
        });
        lock (events)
        {
            Assert.Equal([new InputChangeEvent(Inputs: 5, TimestampUs: 111)], events);
        }
    }

    [Fact]
    public void StaleLinesDrained()
    {
        _port.Feed("OK stale leftover");
        Thread.Sleep(150);
        _port.OnCommand = _ => _port.Feed("OK v0.1.0 proto=1");
        Assert.Equal("v0.1.0 proto=1", _transport.Command("version"));
    }

    [Fact]
    public void PartialLineAssembled()
    {
        _port.OnCommand = _ =>
        {
            _port.FeedRaw("OK v0.");
            _port.FeedRaw("1.0 proto=1\r\n");
        };
        Assert.Equal("v0.1.0 proto=1", _transport.Command("version"));
    }

    [Fact]
    public void CountedExactlyNLines()
    {
        _port.OnCommand = _ => _port.Feed(
            "OK count=2", "  0x00000005 c=1000 p=7 s=1", "  0x0000000A c=2000 p=12 s=0");
        var (data, lines) = _transport.CommandCounted("ts get 256");
        Assert.Equal("count=2", data);
        Assert.Equal(2, lines.Count);
        Assert.Contains("c=1000", lines[0]);
    }

    [Fact]
    public void CountedZero()
    {
        _port.OnCommand = _ => _port.Feed("OK count=0");
        var (data, lines) = _transport.CommandCounted("ts get 256");
        Assert.Equal("count=0", data);
        Assert.Empty(lines);
    }

    [Fact]
    public void CountedErrResponse()
    {
        _port.OnCommand = _ => _port.Feed("ERR NOT_ARMED");
        TestHelpers.AssertSdkThrows(ErrorCode.NotArmed,
            () => _transport.CommandCounted("ts get 256"));
    }

    [Fact]
    public void SyncCountPlainCommandReturnsImmediately()
    {
        _port.OnCommand = _ => _port.Feed("OK count=1000000");
        var sw = Stopwatch.StartNew();
        Assert.Equal("count=1000000", _transport.Command("sync count"));
        Assert.True(sw.Elapsed < TimeSpan.FromSeconds(1));
    }

    [Fact]
    public void RawReturnsUnparsedLine()
    {
        _port.OnCommand = _ => _port.Feed("ERR BAD_CMD");
        Assert.Equal("ERR BAD_CMD", _transport.Raw("nope"));
    }

    [Fact]
    public void PendingCommandDisconnects()
    {
        _transport.CommandTimeout = TimeSpan.FromSeconds(1);
        _port.Closed = true; // reader thread errors out on next read
        TestHelpers.AssertSdkThrows(ErrorCode.Disconnected,
            () => _transport.Command("version"));
    }

    [Fact]
    public void SubsequentCommandsDisconnect()
    {
        _port.Closed = true;
        Thread.Sleep(150);
        TestHelpers.AssertSdkThrows(ErrorCode.Disconnected,
            () => _transport.Command("version"));
    }

    [Fact]
    public void AllPushEventTypes()
    {
        var events = new List<PushEvent>();
        _transport.SetEventCallback(ev =>
        {
            lock (events)
            {
                events.Add(ev);
            }
        });
        _port.Feed(
            "! INPUT 0x000001 t=100",
            "! PATTERN_DONE loops=3",
            "! SYNC_DONE status=ready devnum=1 ts=42");
        WaitFor(() =>
        {
            lock (events)
            {
                return events.Count >= 3;
            }
        });
        lock (events)
        {
            Assert.Equal(
            [
                new InputChangeEvent(Inputs: 1, TimestampUs: 100),
                new PatternDoneEvent(Loops: 3),
                new SyncDoneEvent(Status: "ready", Devnum: 1, Timestamp: 42),
            ], events);
        }
    }

    [Fact]
    public void MalformedPushAsUnknown()
    {
        var events = new List<PushEvent>();
        _transport.SetEventCallback(ev =>
        {
            lock (events)
            {
                events.Add(ev);
            }
        });
        _port.Feed("! INPUT garbage");
        WaitFor(() =>
        {
            lock (events)
            {
                return events.Count > 0;
            }
        });
        lock (events)
        {
            var unknown = Assert.IsType<UnknownEvent>(events[0]);
            Assert.Contains("INPUT garbage", unknown.Raw);
        }
    }
}
