using Xunit;

namespace Pochi.Sdk.Tests;

internal static class TestHelpers
{
    public static SdkException AssertSdkThrows(ErrorCode code, Action act)
    {
        var ex = Assert.Throws<SdkException>(act);
        Assert.Equal(code, ex.Code);
        return ex;
    }
}

public class ParseResponseTests
{
    [Fact]
    public void OkEmpty()
    {
        var r = Protocol.ParseResponse("OK\r\n");
        Assert.Equal((ResponseKind.Ok, ""), (r.Kind, r.Data));
    }

    [Fact]
    public void OkWithData()
    {
        var r = Protocol.ParseResponse("OK v0.1.0 proto=1\r\n");
        Assert.Equal((ResponseKind.Ok, "v0.1.0 proto=1"), (r.Kind, r.Data));
    }

    [Fact]
    public void Err()
    {
        var r = Protocol.ParseResponse("ERR BAD_CMD");
        Assert.Equal((ResponseKind.Err, "BAD_CMD"), (r.Kind, r.Data));
    }

    [Fact]
    public void Push()
    {
        var r = Protocol.ParseResponse("! INPUT 0x05 t=99");
        Assert.Equal((ResponseKind.Push, "INPUT 0x05 t=99"), (r.Kind, r.Data));
    }

    [Theory]
    [InlineData("garbage")]
    [InlineData("OKAY nope")]
    [InlineData("")]
    public void GarbageRejected(string line) =>
        TestHelpers.AssertSdkThrows(ErrorCode.Parse, () => Protocol.ParseResponse(line));

    [Fact]
    public void OkDataMapsErrCodes()
    {
        TestHelpers.AssertSdkThrows(ErrorCode.Busy,
            () => new Response(ResponseKind.Err, "BUSY").OkData());
        TestHelpers.AssertSdkThrows(ErrorCode.UnknownDevice,
            () => new Response(ResponseKind.Err, "WHAT").OkData());
        TestHelpers.AssertSdkThrows(ErrorCode.Parse,
            () => new Response(ResponseKind.Push, "INPUT").OkData());
        TestHelpers.AssertSdkThrows(ErrorCode.BadCommand,
            () => new Response(ResponseKind.Err, "UNKNOWN_CMD").OkData());
    }
}

public class CountFieldTests
{
    [Theory]
    [InlineData("count=2", 2UL)]
    [InlineData("count=0", 0UL)]
    [InlineData("count=1000000", 1000000UL)]
    public void Valid(string data, ulong expected) =>
        Assert.Equal(expected, Protocol.ParseCountField(data));

    [Theory]
    [InlineData("n=2")]
    [InlineData("count=abc")]
    [InlineData("count=-1")]
    public void Invalid(string data) =>
        TestHelpers.AssertSdkThrows(ErrorCode.Parse, () => Protocol.ParseCountField(data));
}

public class CountOverflowFieldTests
{
    [Theory]
    [InlineData("count=3 overflow=0", 3UL, false)]
    [InlineData("count=85 overflow=1", 85UL, true)]
    [InlineData("overflow=1 count=4", 4UL, true)]
    public void NewFwForm(string data, ulong expectedCount, bool expectedOverflow)
    {
        var (count, overflow) = Protocol.ParseCountOverflowField(data);
        Assert.Equal(expectedCount, count);
        Assert.Equal(expectedOverflow, overflow);
    }

    [Theory]
    [InlineData("count=3", 3UL)]
    [InlineData("count=0", 0UL)]
    public void OldFwMissingOverflowDefaultsFalse(string data, ulong expectedCount)
    {
        var (count, overflow) = Protocol.ParseCountOverflowField(data);
        Assert.Equal(expectedCount, count);
        Assert.False(overflow);
    }

    [Theory]
    [InlineData("count=1 overflow=2")]
    [InlineData("count=1 overflow=yes")]
    [InlineData("overflow=0")]
    public void Invalid(string data) =>
        TestHelpers.AssertSdkThrows(ErrorCode.Parse,
            () => Protocol.ParseCountOverflowField(data));
}

public class VersionTests
{
    [Fact]
    public void Basic()
    {
        var v = Protocol.ParseVersion("v0.1.0 proto=1");
        Assert.Equal(((byte)0, (byte)1, (byte)0, (byte)1),
            (v.Major, v.Minor, v.Patch, v.ProtocolVersion));
    }

    [Fact]
    public void MultiDigit()
    {
        var v = Protocol.ParseVersion("v12.34.56 proto=2");
        Assert.Equal(((byte)12, (byte)34, (byte)56), (v.Major, v.Minor, v.Patch));
    }

    [Theory]
    [InlineData("proto=1")]
    [InlineData("v0.1.0")]
    [InlineData("v0.1 proto=1")]
    [InlineData("vX.Y.Z proto=1")]
    [InlineData("")]
    public void Malformed(string data) =>
        TestHelpers.AssertSdkThrows(ErrorCode.Parse, () => Protocol.ParseVersion(data));
}

public class CapsTests
{
    private const string Good =
        "dio=23 out=12 in=11 ts_res=40ns pattern=256 ring=256 feat=0x00000001";

    [Fact]
    public void Basic()
    {
        var c = Protocol.ParseCaps(Good);
        Assert.Equal(23, c.MaxDio);
        Assert.Equal(12, c.OutCount);
        Assert.Equal(11, c.InCount);
        Assert.Equal(40U, c.TsResolutionNs);
        Assert.Equal(256, c.MaxPatternSteps);
        Assert.Equal(256, c.TsRingEvents);
        Assert.NotEqual(0U, c.Features & Feature.Sync);
        Assert.True(c.HasSync);
        Assert.False(c.HasReset);
    }

    [Fact]
    public void HasReset()
    {
        Assert.Equal(0x1U, Feature.Sync);
        Assert.Equal(0x2U, Feature.Reset);

        var both = Protocol.ParseCaps(
            "dio=23 out=12 in=11 ts_res=40ns pattern=256 ring=256 feat=0x00000003");
        Assert.True(both.HasSync);
        Assert.True(both.HasReset);

        var none = Protocol.ParseCaps(
            "dio=23 out=12 in=11 ts_res=40ns pattern=256 ring=256 feat=0x00000000");
        Assert.False(none.HasSync);
        Assert.False(none.HasReset);
    }

    [Fact]
    public void OldFirmwareRejected() =>
        TestHelpers.AssertSdkThrows(ErrorCode.UnsupportedFirmware, () =>
            Protocol.ParseCaps(
                "dio=23 out=12 in=11 ts_res=1000ns pattern=256 ring=256 feat=0x1"));

    [Theory]
    [InlineData("dio=23 out=12 in=11")]
    [InlineData("dio=banana out=12 in=11 ts_res=40ns pattern=256 ring=256 feat=0x1")]
    public void Malformed(string data) =>
        TestHelpers.AssertSdkThrows(ErrorCode.Parse, () => Protocol.ParseCaps(data));
}

public class InfoTests
{
    [Fact]
    public void Basic() =>
        Assert.Equal(("AABBCCDD11223344", (byte?)42),
            Protocol.ParseInfo("uid=AABBCCDD11223344 devnum=42"));

    [Fact]
    public void Unassigned() =>
        Assert.Equal(("AABB", (byte?)null), Protocol.ParseInfo("uid=AABB devnum=255"));

    [Theory]
    [InlineData("devnum=1")]
    [InlineData("uid=AABB devnum=zzz")]
    public void Malformed(string data) =>
        TestHelpers.AssertSdkThrows(ErrorCode.Parse, () => Protocol.ParseInfo(data));
}

public class MapTests
{
    [Fact]
    public void Basic()
    {
        var m = Protocol.ParseMap("v=1 out=0:12 in=12:11 pull=up flags=0x01");
        Assert.Equal(((byte)0, (byte)12, (byte)12, (byte)11),
            (m.OutBase, m.OutCount, m.InBase, m.InCount));
        Assert.Equal(PullMode.Up, m.Pull);
        Assert.Equal(1, m.Flags);
    }

    [Theory]
    [InlineData("v=1 out=0:0 in=0:23 pull=sideways flags=0x01")]
    [InlineData("v=1 out=0:12")]
    [InlineData("v=1 out=012 in=0:23 pull=up flags=0x01")]
    public void Malformed(string data) =>
        TestHelpers.AssertSdkThrows(ErrorCode.Parse, () => Protocol.ParseMap(data));

    [Fact]
    public void RoundTripHex()
    {
        var m = Protocol.ParseMap("v=1 out=0:12 in=12:11 pull=up flags=0x01");
        var hex = Protocol.MapToHex(m);
        Assert.Equal(48, hex.Length);
        var data = Convert.FromHexString(hex);
        Assert.Equal(new byte[] { 1, 0, 12, 12, 11, 1, 1 }, data[..7]);
        Assert.All(data[7..], b => Assert.Equal(0, b));
    }
}

public class ReadStateTests
{
    [Fact]
    public void Read()
    {
        Assert.Equal(5U, Protocol.ParseRead("0x000005"));
        Assert.Equal(0U, Protocol.ParseRead(" 0x0 "));
    }

    [Theory]
    [InlineData("five")]
    [InlineData("")]
    public void ReadMalformed(string data) =>
        TestHelpers.AssertSdkThrows(ErrorCode.Parse, () => Protocol.ParseRead(data));

    [Fact]
    public void State()
    {
        var s = Protocol.ParseState("in=0x000005 out=0x00000A flags=0x00");
        Assert.Equal((5U, 10U, (byte)0), (s.Inputs, s.Outputs, s.Flags));
    }

    [Fact]
    public void StateMissingField() =>
        TestHelpers.AssertSdkThrows(ErrorCode.Parse,
            () => Protocol.ParseState("in=0x05 out=0x0A"));
}

public class PatternTests
{
    [Fact]
    public void HexCountPrefix()
    {
        var hex = Protocol.PatternToHex(
        [
            new PatternStep(OutBits: 0x0F, HoldUs: 100),
            new PatternStep(OutBits: 0, HoldUs: 200),
        ]);
        var data = Convert.FromHexString(hex);
        Assert.Equal(2 + 2 * 8, data.Length);
        Assert.Equal(2, BitConverter.ToUInt16(data, 0));
        Assert.Equal(0x0FU, BitConverter.ToUInt32(data, 2));
        Assert.Equal(100U, BitConverter.ToUInt32(data, 6));
    }

    [Fact]
    public void EmptyRejected() =>
        TestHelpers.AssertSdkThrows(ErrorCode.Parse, () => Protocol.PatternToHex([]));

    [Fact]
    public void Accepted()
    {
        Assert.Equal(4, Protocol.ParseAccepted("accepted=4"));
        TestHelpers.AssertSdkThrows(ErrorCode.Parse, () => Protocol.ParseAccepted("ok"));
    }

    [Fact]
    public void RunCommands()
    {
        Assert.Equal("pattern run once 1", Protocol.PatternRunCommand(PatternMode.Once, 1));
        Assert.Equal("pattern run loop 10", Protocol.PatternRunCommand(PatternMode.Loop, 10));
    }

    [Theory]
    [InlineData("idle", PatternState.Idle)]
    [InlineData("loaded", PatternState.Loaded)]
    [InlineData("running", PatternState.Running)]
    [InlineData("done", PatternState.Done)]
    public void StatusStates(string state, PatternState expected)
    {
        var s = Protocol.ParsePatternStatus($"state={state} step=0 loops=0");
        Assert.Equal(expected, s.State);
    }

    [Theory]
    [InlineData("state=paused step=0 loops=0")]
    [InlineData("state=idle")]
    public void StatusMalformed(string data) =>
        TestHelpers.AssertSdkThrows(ErrorCode.Parse,
            () => Protocol.ParsePatternStatus(data));
}

public class TimestampTests
{
    [Fact]
    public void ArmCommands()
    {
        Assert.Equal("ts arm 0x7ff rising", Protocol.TsArmCommand(0x07FF, EdgeMode.Rising));
        Assert.Equal("ts arm 0xff both", Protocol.TsArmCommand(0xFF, EdgeMode.Both));
    }

    [Fact]
    public void EventBasic()
    {
        var ev = Protocol.ParseTsEventLine("  0x00000005 c=1000 p=7 s=1");
        Assert.Equal(5U, ev.Inputs);
        Assert.Equal(1000U, ev.RawCount);
        Assert.Equal(7, ev.RawPhase);
        Assert.True(ev.SyncActive);
        Assert.Equal(1_000_280, ev.TimestampNs);
    }

    [Fact]
    public void EventFreeRunning()
    {
        var ev = Protocol.ParseTsEventLine("0x00000001 c=500 p=0 s=0");
        Assert.False(ev.SyncActive);
        Assert.Equal(500_000, ev.TimestampNs);
    }

    [Fact]
    public void OldFormatUnsupportedFirmware() =>
        TestHelpers.AssertSdkThrows(ErrorCode.UnsupportedFirmware,
            () => Protocol.ParseTsEventLine("0x00000005 t=1234567890"));

    [Theory]
    [InlineData("0x05 c=1000 p=7")]
    [InlineData("c=1000 p=7 s=1")]
    [InlineData("")]
    [InlineData("0x05 c=1000 p=7 s=2")]
    public void EventMalformed(string line) =>
        TestHelpers.AssertSdkThrows(ErrorCode.Parse,
            () => Protocol.ParseTsEventLine(line));
}

public class SyncTests
{
    [Fact]
    public void Count()
    {
        Assert.Equal(1_000_000UL, Protocol.ParseSyncCount("count=1000000"));
        TestHelpers.AssertSdkThrows(ErrorCode.Parse,
            () => Protocol.ParseSyncCount("1000000"));
    }
}

public class PushEventTests
{
    [Fact]
    public void Input() =>
        Assert.Equal(new InputChangeEvent(Inputs: 5, TimestampUs: 1234567890),
            Protocol.ParsePushEvent("INPUT 0x000005 t=1234567890"));

    [Fact]
    public void PatternDone() =>
        Assert.Equal(new PatternDoneEvent(Loops: 10),
            Protocol.ParsePushEvent("PATTERN_DONE loops=10"));

    [Fact]
    public void PatternTimeout() =>
        Assert.Equal(new PatternTimeoutEvent(Loops: 42),
            Protocol.ParsePushEvent("PATTERN_TIMEOUT loops=42"));

    [Fact]
    public void PatternTimeoutZeroLoops() =>
        Assert.Equal(new PatternTimeoutEvent(Loops: 0),
            Protocol.ParsePushEvent("PATTERN_TIMEOUT loops=0"));

    [Fact]
    public void SyncDone() =>
        Assert.Equal(new SyncDoneEvent(Status: "ready", Devnum: 1, Timestamp: 12345),
            Protocol.ParsePushEvent("SYNC_DONE status=ready devnum=1 ts=12345"));

    [Fact]
    public void UnknownPreserved() =>
        Assert.Equal(new UnknownEvent(Raw: "FUTURE_EVENT data=1"),
            Protocol.ParsePushEvent("FUTURE_EVENT data=1"));

    [Theory]
    [InlineData("INPUT t=99")]
    [InlineData("INPUT 0x05")]
    [InlineData("PATTERN_DONE loops=abc")]
    [InlineData("PATTERN_TIMEOUT")]
    [InlineData("PATTERN_TIMEOUT loops=xyz")]
    public void Malformed(string payload) =>
        TestHelpers.AssertSdkThrows(ErrorCode.Parse,
            () => Protocol.ParsePushEvent(payload));
}
