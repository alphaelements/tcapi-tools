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

// Parser and builder unit tests (happy path + boundary + malformed input).
// The lines here are parser inputs, not fake-device output; the golden
// conformance of the same parsers is in GoldenReplayTests.

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
        var r = Protocol.ParseResponse("OK fw=0.1.3 proto=2\r\n");
        Assert.Equal((ResponseKind.Ok, "fw=0.1.3 proto=2"), (r.Kind, r.Data));
    }

    [Fact]
    public void Err()
    {
        var r = Protocol.ParseResponse("ERR BAD_MAP");
        Assert.Equal((ResponseKind.Err, "BAD_MAP"), (r.Kind, r.Data));
    }

    [Fact]
    public void Push()
    {
        var r = Protocol.ParseResponse("! INPUT in=0x00000005 t=99");
        Assert.Equal((ResponseKind.Push, "INPUT in=0x00000005 t=99"), (r.Kind, r.Data));
    }

    [Theory]
    [InlineData("garbage")]
    [InlineData("OKAY nope")]
    [InlineData("")]
    public void GarbageRejected(string line) =>
        TestHelpers.AssertSdkThrows(ErrorCode.Parse, () => Protocol.ParseResponse(line));

    [Fact]
    public void OkDataMapsEveryDeviceError()
    {
        var expected = new Dictionary<string, ErrorCode>
        {
            ["BAD_PARAM"] = ErrorCode.BadParam,
            ["BAD_MAP"] = ErrorCode.BadMap,
            ["BUSY"] = ErrorCode.Busy,
            ["FLASH"] = ErrorCode.Flash,
            ["TOO_LONG"] = ErrorCode.TooLong,
            ["NOT_ARMED"] = ErrorCode.NotArmed,
            ["SYNC_STATE"] = ErrorCode.SyncState,
            ["NO_RESOURCE"] = ErrorCode.NoResource,
            ["NOT_RUNNING"] = ErrorCode.NotRunning,
            ["UNKNOWN_CMD"] = ErrorCode.UnknownCmd,
            ["LINE_TOO_LONG"] = ErrorCode.LineTooLong,
            ["BAD_CMD"] = ErrorCode.BadCommand,
            ["TRANSPORT_NOT_SUPPORTED"] = ErrorCode.TransportNotSupported,
        };
        foreach (var (name, code) in expected)
        {
            TestHelpers.AssertSdkThrows(
                code, () => new Response(ResponseKind.Err, name).OkData());
        }
    }

    [Fact]
    public void UnknownErrorNameIsPreservedNotDefaulted()
    {
        var ex = TestHelpers.AssertSdkThrows(
            ErrorCode.UnknownDevice, () => new Response(ResponseKind.Err, "WHAT").OkData());
        Assert.Contains("WHAT", ex.Message);
        // SYNC_TIMEOUT does not exist in v2: it is an unknown name like any other.
        TestHelpers.AssertSdkThrows(
            ErrorCode.UnknownDevice,
            () => new Response(ResponseKind.Err, "SYNC_TIMEOUT").OkData());
    }

    [Fact]
    public void PushInResponsePositionIsAParseError() =>
        TestHelpers.AssertSdkThrows(
            ErrorCode.Parse, () => new Response(ResponseKind.Push, "INPUT").OkData());
}

public class CountFieldTests
{
    [Theory]
    [InlineData("count=2", 2UL)]
    [InlineData("count=0", 0UL)]
    [InlineData("count=16", 16UL)]
    [InlineData("count=3 overflow=0", 3UL)]
    public void Valid(string data, ulong expected) =>
        Assert.Equal(expected, Protocol.ParseCountField(data));

    [Theory]
    [InlineData("n=2")]
    [InlineData("count=abc")]
    [InlineData("count=-1")]
    [InlineData("count=")]
    [InlineData("clocks=5")]
    public void Invalid(string data) =>
        TestHelpers.AssertSdkThrows(ErrorCode.Parse, () => Protocol.ParseCountField(data));

    [Fact]
    public void TryParseCountFieldIsNullForASingleLineResponse()
    {
        Assert.Null(Protocol.TryParseCountField("clocks=5"));
        Assert.Null(Protocol.TryParseCountField(""));
        Assert.Equal(4UL, Protocol.TryParseCountField("count=4 overflow=1"));
        TestHelpers.AssertSdkThrows(
            ErrorCode.Parse, () => Protocol.TryParseCountField("count=x"));
    }
}

public class FieldStrictnessTests
{
    [Theory]
    [InlineData("pong=1 extra=2")]
    [InlineData("pong=1 pong=2")]
    [InlineData("pong")]
    [InlineData("1")]
    [InlineData("")]
    [InlineData("pong=+1")]
    [InlineData("pong=-1")]
    [InlineData("pong=")]
    [InlineData("pong=4294967296")]
    [InlineData("pong=0x1")]
    [InlineData("pong= 1")]
    public void MalformedPong(string data) =>
        TestHelpers.AssertSdkThrows(ErrorCode.Parse, () => Protocol.ParsePong(data));

    [Theory]
    [InlineData("pong=0", 0U)]
    [InlineData("pong=12345", 12345U)]
    [InlineData("pong=4294967295", uint.MaxValue)]
    public void Pong(string data, uint expected) =>
        Assert.Equal(expected, Protocol.ParsePong(data));

    [Theory]
    [InlineData("in=0x")]
    [InlineData("in=0x+5")]
    [InlineData("in=")]
    [InlineData("in=0x100000000")]
    [InlineData("in=0xg")]
    [InlineData("in=5 in=6")]
    public void MalformedMasks(string data) =>
        TestHelpers.AssertSdkThrows(ErrorCode.Parse, () => Protocol.ParseRead(data));

    [Fact]
    public void MasksAcceptHexAndDecimalWithLeadingZeros()
    {
        Assert.Equal(5U, Protocol.ParseRead("in=0x00000005"));
        Assert.Equal(5U, Protocol.ParseRead("in=5"));
        Assert.Equal(uint.MaxValue, Protocol.ParseRead("in=0xffffffff"));
        Assert.Equal(7U, Protocol.ParseRead("in=0x000000000000007"));
    }

    [Fact]
    public void ParseU32RejectsOverflowAndJunk()
    {
        TestHelpers.AssertSdkThrows(ErrorCode.Parse, () => Protocol.ParseU32("4294967296"));
        TestHelpers.AssertSdkThrows(ErrorCode.Parse, () => Protocol.ParseU32(""));
        TestHelpers.AssertSdkThrows(ErrorCode.Parse, () => Protocol.ParseU32("1 "));
    }
}

public class VersionTests
{
    [Fact]
    public void Basic()
    {
        var v = Protocol.ParseVersion("fw=0.1.3 proto=2");
        Assert.Equal(((byte)0, (byte)1, (byte)3, (byte)2),
            (v.Major, v.Minor, v.Patch, v.ProtocolVersion));
    }

    [Fact]
    public void MultiDigitAndKeyOrder()
    {
        var v = Protocol.ParseVersion("proto=2 fw=12.34.56");
        Assert.Equal(((byte)12, (byte)34, (byte)56), (v.Major, v.Minor, v.Patch));
    }

    [Fact]
    public void ForeignProtocolIsReportedAsIs() =>
        Assert.Equal(7, Protocol.ParseVersion("fw=0.1.0 proto=7").ProtocolVersion);

    [Theory]
    [InlineData("proto=2")]
    [InlineData("fw=0.1.3")]
    [InlineData("fw=0.1 proto=2")]
    [InlineData("fw=0.1.3.4 proto=2")]
    [InlineData("fw=X.Y.Z proto=2")]
    [InlineData("fw=v0.1.3 proto=2")]
    [InlineData("fw=0.1.256 proto=2")]
    [InlineData("fw=0.1.3 proto=two")]
    [InlineData("v0.1.0 proto=7")]
    [InlineData("")]
    public void Malformed(string data) =>
        TestHelpers.AssertSdkThrows(ErrorCode.Parse, () => Protocol.ParseVersion(data));
}

public class CapsTests
{
    private const string Good =
        "dio=25 out=2 in=23 ts_res_ns=40 tick_ns=200 pattern=256 ring=256 feat=0x00000003";

    [Fact]
    public void Basic()
    {
        var c = Protocol.ParseCaps(Good);
        Assert.Equal(new Capabilities(25, 2, 23, 40, 200, 256, 256, 3), c);
        Assert.True(c.HasSync);
        Assert.True(c.HasReset);
    }

    [Fact]
    public void ZeroFeatures()
    {
        var c = Protocol.ParseCaps(Good.Replace("feat=0x00000003", "feat=0x00000000"));
        Assert.False(c.HasSync);
        Assert.False(c.HasReset);
    }

    [Theory]
    [InlineData("dio=25 out=12 in=11")]
    [InlineData("dio=banana out=2 in=23 ts_res_ns=40 tick_ns=200 pattern=256 ring=256 feat=0x3")]
    [InlineData("dio=25 out=2 in=23 ts_res_ns=40 tick_ns=200 pattern=65536 ring=256 feat=0x3")]
    [InlineData("dio=25 out=2 in=23 pattern=256 ring=256 feat=0x3")]
    public void Malformed(string data) =>
        TestHelpers.AssertSdkThrows(ErrorCode.Parse, () => Protocol.ParseCaps(data));

    [Fact]
    public void UnknownKeyIsRejected() =>
        TestHelpers.AssertSdkThrows(ErrorCode.Parse, () => Protocol.ParseCaps(Good + " proto=2"));
}

public class InfoTests
{
    [Fact]
    public void Basic() =>
        Assert.Equal(("AABBCCDD11223344", (byte?)42),
            Protocol.ParseInfo("uid=AABBCCDD11223344 devnum=42"));

    [Theory]
    [InlineData("devnum=255", null)]
    [InlineData("devnum=0", 0)]
    [InlineData("devnum=254", 254)]
    public void DeviceNumberBoundaries(string devnum, int? expected) =>
        Assert.Equal(
            (byte?)expected, Protocol.ParseInfo("uid=0000000000000000 " + devnum).DeviceNumber);

    [Theory]
    [InlineData("devnum=1")]
    [InlineData("uid=AABBCCDD11223344")]
    [InlineData("uid=AABB devnum=1")]
    [InlineData("uid=ZZBBCCDD11223344 devnum=1")]
    [InlineData("uid=AABBCCDD11223344 devnum=256")]
    [InlineData("uid=AABBCCDD11223344 devnum=zzz")]
    public void Malformed(string data) =>
        TestHelpers.AssertSdkThrows(ErrorCode.Parse, () => Protocol.ParseInfo(data));

    [Fact]
    public void Commands()
    {
        Assert.Equal("devnum 7", Protocol.DevnumCommand(7));
        Assert.Equal("devnum 255", Protocol.DevnumCommand(255));
        Assert.Equal("ping 4294967295", Protocol.PingCommand(uint.MaxValue));
    }
}

public class MapTests
{
    private static readonly string Doc = PinMapTests.DocMapArgs;

    [Fact]
    public void GetRoundTripsThroughSetCommand()
    {
        var map = Protocol.ParseMap(Doc);
        Assert.Equal("map set " + Doc, Protocol.MapSetCommand(map));
    }

    [Fact]
    public void RejectsWrongVersion() =>
        TestHelpers.AssertSdkThrows(
            ErrorCode.Parse, () => Protocol.ParseMap(Doc.Replace("v=2", "v=3")));

    [Fact]
    public void RejectsRangeBasedLegacyShape() =>
        TestHelpers.AssertSdkThrows(
            ErrorCode.Parse, () => Protocol.ParseMap("v=2 out=0:12 in=12:11 pull=up flags=0x01"));

    [Theory]
    [InlineData("v=2 flags=0x00")]
    [InlineData("flags=0x00 dir=0x0 pu=0x0 pd=0x0 def=0x0 opol=0x0 ipol=0x0 edge=0x0")]
    public void MissingFields(string data) =>
        TestHelpers.AssertSdkThrows(ErrorCode.Parse, () => Protocol.ParseMap(data));

    [Fact]
    public void UnknownOrBadFields()
    {
        TestHelpers.AssertSdkThrows(ErrorCode.Parse, () => Protocol.ParseMap(Doc + " extra=0x0"));
        TestHelpers.AssertSdkThrows(
            ErrorCode.Parse, () => Protocol.ParseMap(Doc.Replace("flags=0x00", "flags=0x100")));
        TestHelpers.AssertSdkThrows(
            ErrorCode.Parse, () => Protocol.ParseMap(Doc.Replace("pu=0x000000f0", "pu=0xzz")));
    }

    [Fact]
    public void InvalidDeviceMapIsAnErrorNotAValue() =>
        TestHelpers.AssertSdkThrows(
            ErrorCode.Parse,
            () => Protocol.ParseMap(Doc.Replace("dir=0x0000000f", "dir=0x0080000f")));

    [Fact]
    public void SetCommandRefusesAnInvalidMap() =>
        TestHelpers.AssertSdkThrows(
            ErrorCode.InvalidArgument,
            () => Protocol.MapSetCommand(PinMapTests.DocMap with { Flags = 1 }));
}

public class ReadStateWriteTests
{
    [Fact]
    public void Read() => Assert.Equal(0xF0U, Protocol.ParseRead("in=0x000000f0"));

    [Fact]
    public void State() =>
        Assert.Equal(new IoState(0x30, 0x05), Protocol.ParseState("in=0x00000030 out=0x00000005"));

    [Theory]
    [InlineData("in=0x30")]
    [InlineData("in=0x30 out=0x5 flags=0x00")]
    [InlineData("out=0x5 outx=0x1")]
    public void StateMalformed(string data) =>
        TestHelpers.AssertSdkThrows(ErrorCode.Parse, () => Protocol.ParseState(data));

    [Fact]
    public void WriteCommandIsCanonical()
    {
        Assert.Equal("write 0x2 0x3", Protocol.WriteCommand(2, 3));
        Assert.Equal("write 0xc7fffff 0xc7fffff", Protocol.WriteCommand(0xC7F_FFFF, 0xC7F_FFFF));
        Assert.Equal("write 0x0 0x0", Protocol.WriteCommand(0, 0));
    }

    [Theory]
    [InlineData(0U, 0x0080_0000U)]
    [InlineData(0U, 0x0100_0000U)]
    [InlineData(0xFFFF_FFFFU, 0xFFFF_FFFFU)]
    [InlineData(1U, 0x1000_0001U)]
    public void WriteCommandRejectsAMaskOutsideTheDioPins(uint values, uint mask) =>
        TestHelpers.AssertSdkThrows(
            ErrorCode.InvalidArgument, () => Protocol.WriteCommand(values, mask));

    [Fact]
    public void WriteCommandAcceptsValueBitsOutsideTheMask()
    {
        // The golden io transcript: value bits outside the mask are ignored by
        // the device, including bits that are not DIO pins.
        Assert.Equal("write 0xffffffff 0x8", Protocol.WriteCommand(0xFFFF_FFFF, 0x8));
        Assert.Contains(
            "OK",
            GoldenCorpus.Case("io", "write: val bits outside the mask are ignored")
                .Steps.Where(s => s.Text == "write 0xffffffff 0x8").SelectMany(s => s.Response));
    }
}

public class PatternTests
{
    [Fact]
    public void AddCommandSingleLine()
    {
        var lines = Protocol.PatternAddCommands([new(1, 5), new(0, 10)]);
        Assert.Equal(["pattern add 0x1:5 0x0:10"], lines);
    }

    [Fact]
    public void AddCommandPacksToTheLineLimitWithoutSplittingASteps()
    {
        var steps = Enumerable.Range(0, 300).Select(_ => new PatternStep(1, 5)).ToList();
        var lines = Protocol.PatternAddCommands(steps);
        Assert.All(lines, l => Assert.True(l.Length <= Protocol.MaxLineBytes, l));
        Assert.StartsWith("pattern add ", lines[0], StringComparison.Ordinal);
        var packed = lines.SelectMany(l => l["pattern add ".Length..].Split(' ')).ToList();
        Assert.Equal(steps.Select(s => s.ToText()), packed);
        // "pattern add" + 40 x " 0x1:5" is 251 bytes; a 41st step would make 257.
        Assert.Equal(40, lines[0].Split(' ').Length - 2);
    }

    [Fact]
    public void AddCommandAcceptsALineOfExactly256Bytes()
    {
        // 11 + 39 x 6 = 245, plus " 0x1:123456" (11 bytes) = 256.
        var steps = Enumerable.Range(0, 39).Select(_ => new PatternStep(1, 5)).ToList();
        steps.Add(new PatternStep(1, 123456));
        var lines = Protocol.PatternAddCommands(steps);
        Assert.Single(lines);
        Assert.Equal(256, lines[0].Length);
    }

    [Fact]
    public void AddCommandStartsANewLineAt257Bytes()
    {
        var steps = Enumerable.Range(0, 39).Select(_ => new PatternStep(1, 5)).ToList();
        steps.Add(new PatternStep(1, 1234567)); // would make 257
        var lines = Protocol.PatternAddCommands(steps);
        Assert.Equal(2, lines.Count);
        Assert.Equal("pattern add 0x1:1234567", lines[1]);
    }

    [Fact]
    public void AddCommandValidatesEveryStepBeforeProducingAnything()
    {
        TestHelpers.AssertSdkThrows(
            ErrorCode.InvalidArgument, () => Protocol.PatternAddCommands([]));
        TestHelpers.AssertSdkThrows(
            ErrorCode.InvalidArgument,
            () => Protocol.PatternAddCommands([new(1, 5), new(1, 0)]));
        TestHelpers.AssertSdkThrows(
            ErrorCode.InvalidArgument,
            () => Protocol.PatternAddCommands([new(1, 5), new(0x0080_0000, 1)]));
    }

    [Fact]
    public void Total()
    {
        Assert.Equal(256, Protocol.ParsePatternTotal("total=256"));
        TestHelpers.AssertSdkThrows(ErrorCode.Parse, () => Protocol.ParsePatternTotal("total=65536"));
        TestHelpers.AssertSdkThrows(ErrorCode.Parse, () => Protocol.ParsePatternTotal("accepted=4"));
    }

    [Fact]
    public void RunCommands()
    {
        Assert.Equal("pattern run once", Protocol.PatternRunCommand(PatternMode.Once, 1));
        Assert.Equal("pattern run once", Protocol.PatternRunCommand(PatternMode.Once, 0));
        Assert.Equal("pattern run loop 10", Protocol.PatternRunCommand(PatternMode.Loop, 10));
        Assert.Equal(
            "pattern run loop 65535", Protocol.PatternRunCommand(PatternMode.Loop, ushort.MaxValue));
    }

    [Fact]
    public void LoopNeedsARepeatOfAtLeastOne() =>
        TestHelpers.AssertSdkThrows(
            ErrorCode.InvalidArgument, () => Protocol.PatternRunCommand(PatternMode.Loop, 0));

    [Theory]
    [InlineData("idle", PatternState.Idle)]
    [InlineData("loaded", PatternState.Loaded)]
    [InlineData("running", PatternState.Running)]
    [InlineData("done", PatternState.Done)]
    public void StatusStates(string state, PatternState expected) =>
        Assert.Equal(
            new PatternStatus(expected, 1, 2, 3),
            Protocol.ParsePatternStatus($"state={state} step=1 loops=2 total=3"));

    [Theory]
    [InlineData("state=paused step=0 loops=0 total=0")]
    [InlineData("state=idle step=0 loops=0")]
    [InlineData("state=idle step=0 loops=0 total=65536")]
    public void StatusMalformed(string data) =>
        TestHelpers.AssertSdkThrows(ErrorCode.Parse, () => Protocol.ParsePatternStatus(data));
}

public class TimestampTests
{
    [Fact]
    public void ArmCommands()
    {
        Assert.Equal("ts arm 0x7ff rising", Protocol.TsArmCommand(0x07FF, EdgeMode.Rising));
        Assert.Equal("ts arm 0xff both", Protocol.TsArmCommand(0xFF, EdgeMode.Both));
        Assert.Equal("ts arm 0x1 falling", Protocol.TsArmCommand(1, EdgeMode.Falling));
    }

    [Theory]
    [InlineData(0U)]
    [InlineData(0x0080_0000U)]
    [InlineData(0x1000_0000U)]
    public void ArmCommandRejectsEmptyAndNonDioMasks(uint mask) =>
        TestHelpers.AssertSdkThrows(
            ErrorCode.InvalidArgument, () => Protocol.TsArmCommand(mask, EdgeMode.Both));

    [Theory]
    [InlineData(1, "ts get 1")]
    [InlineData(85, "ts get 85")]
    public void GetCommandBounds(ushort max, string expected) =>
        Assert.Equal(expected, Protocol.TsGetCommand(max));

    [Theory]
    [InlineData(0)]
    [InlineData(86)]
    [InlineData(256)]
    public void GetCommandRejectsOutOfRange(ushort max) =>
        TestHelpers.AssertSdkThrows(ErrorCode.InvalidArgument, () => Protocol.TsGetCommand(max));

    [Fact]
    public void Status() =>
        Assert.Equal(
            new TsStatus(true, 256, true), Protocol.ParseTsStatus("armed=1 pending=256 overflow=1"));

    [Theory]
    [InlineData("armed=2 pending=0 overflow=0")]
    [InlineData("armed=1 pending=0")]
    [InlineData("armed=1 pending=-1 overflow=0")]
    public void StatusMalformed(string data) =>
        TestHelpers.AssertSdkThrows(ErrorCode.Parse, () => Protocol.ParseTsStatus(data));

    [Theory]
    [InlineData("count=3 overflow=0", 3U, false)]
    [InlineData("count=85 overflow=1", 85U, true)]
    [InlineData("overflow=1 count=4", 4U, true)]
    [InlineData("count=0 overflow=0", 0U, false)]
    public void GetHeader(string data, uint count, bool overflow) =>
        Assert.Equal((count, overflow), Protocol.ParseTsGetHeader(data));

    [Theory]
    [InlineData("count=3")]
    [InlineData("overflow=0")]
    [InlineData("count=1 overflow=2")]
    [InlineData("count=1 overflow=yes")]
    [InlineData("count=1 overflow=0 extra=1")]
    public void GetHeaderMalformed(string data) =>
        TestHelpers.AssertSdkThrows(ErrorCode.Parse, () => Protocol.ParseTsGetHeader(data));

    [Fact]
    public void EventBasic()
    {
        var ev = Protocol.ParseTsEventLine("  in=0x00000005 c=1000 p=7 s=1");
        Assert.Equal(new TimestampEvent(5, 1000, 7, true), ev);
        Assert.Equal(1_000_280, ev.Ns(40));
    }

    [Fact]
    public void EventFreeRunningAndPhaseBounds()
    {
        Assert.False(Protocol.ParseTsEventLine("in=0x00000001 c=500 p=0 s=0").SyncActive);
        Assert.Equal(24, Protocol.ParseTsEventLine("in=0x1 c=1 p=24 s=1").RawPhase);
        Assert.Equal(
            uint.MaxValue, Protocol.ParseTsEventLine("in=0x1 c=4294967295 p=0 s=0").RawCount);
    }

    [Theory]
    [InlineData("in=0x05 c=1000 p=7")]
    [InlineData("c=1000 p=7 s=1")]
    [InlineData("")]
    [InlineData("in=0x05 c=1000 p=7 s=2")]
    [InlineData("in=0x05 c=1000 p=25 s=1")]
    [InlineData("in=0x05 c=4294967296 p=7 s=1")]
    [InlineData("0x05 c=1000 p=7 s=1")]
    [InlineData("in=0x05 t=123456 s=1")]
    public void EventMalformed(string line) =>
        TestHelpers.AssertSdkThrows(ErrorCode.Parse, () => Protocol.ParseTsEventLine(line));
}

public class SyncTests
{
    [Theory]
    [InlineData("clocks=0", 0UL)]
    [InlineData("clocks=1000000", 1_000_000UL)]
    [InlineData("clocks=18446744073709551615", ulong.MaxValue)]
    public void Count(string data, ulong expected) =>
        Assert.Equal(expected, Protocol.ParseSyncCount(data));

    [Theory]
    [InlineData("1000000")]
    [InlineData("count=5")]
    [InlineData("clocks=18446744073709551616")]
    public void CountMalformed(string data) =>
        TestHelpers.AssertSdkThrows(ErrorCode.Parse, () => Protocol.ParseSyncCount(data));
}

public class PushEventTests
{
    [Fact]
    public void Input() =>
        Assert.Equal(new InputChangeEvent(Inputs: 5, TUs: 1234567890),
            Protocol.ParsePushEvent("INPUT in=0x00000005 t=1234567890"));

    [Fact]
    public void InputTimeIsU64() =>
        Assert.Equal(new InputChangeEvent(1, ulong.MaxValue),
            Protocol.ParsePushEvent("INPUT in=0x00000001 t=18446744073709551615"));

    [Fact]
    public void PatternDone() =>
        Assert.Equal(new PatternDoneEvent(Loops: 10),
            Protocol.ParsePushEvent("PATTERN_DONE loops=10"));

    [Fact]
    public void PatternTimeout()
    {
        Assert.Equal(new PatternTimeoutEvent(Loops: 42),
            Protocol.ParsePushEvent("PATTERN_TIMEOUT loops=42"));
        Assert.Equal(new PatternTimeoutEvent(Loops: 0),
            Protocol.ParsePushEvent("PATTERN_TIMEOUT loops=0"));
    }

    [Theory]
    [InlineData("INPUT t=99")]
    [InlineData("INPUT in=0x05")]
    [InlineData("INPUT 0x05 t=5")]
    [InlineData("PATTERN_DONE loops=abc")]
    [InlineData("PATTERN_DONE loops=65536")]
    [InlineData("PATTERN_TIMEOUT")]
    [InlineData("PATTERN_TIMEOUT loops=xyz")]
    public void Malformed(string payload) =>
        TestHelpers.AssertSdkThrows(ErrorCode.Parse, () => Protocol.ParsePushEvent(payload));

    [Theory]
    [InlineData("FUTURE_EVENT data=1")]
    [InlineData("")]
    public void UnknownEventIsAnError(string payload)
    {
        // The device sends exactly three events; the transport logs and drops
        // anything else (TransportTests), the parser does not invent a type.
        var ex = TestHelpers.AssertSdkThrows(
            ErrorCode.Parse, () => Protocol.ParsePushEvent(payload));
        Assert.Contains("unknown event", ex.Message);
    }
}

public class RequestLineTests
{
    [Fact]
    public void AcceptsUpTo256Bytes()
    {
        Protocol.CheckRequestLine(new string('a', 256));
        Protocol.CheckRequestLine("a");
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("\t")]
    public void RejectsABlankLineBecauseTheDeviceNeverAnswersIt(string line) =>
        TestHelpers.AssertSdkThrows(ErrorCode.InvalidArgument, () => Protocol.CheckRequestLine(line));

    [Fact]
    public void RejectsMoreThan256Bytes() =>
        TestHelpers.AssertSdkThrows(
            ErrorCode.InvalidArgument, () => Protocol.CheckRequestLine(new string('a', 257)));

    [Fact]
    public void CountsBytesNotCharacters() =>
        // 129 two-byte characters are 258 bytes.
        TestHelpers.AssertSdkThrows(
            ErrorCode.InvalidArgument, () => Protocol.CheckRequestLine(new string('é', 129)));

    [Theory]
    [InlineData("read\nread")]
    [InlineData("read\r")]
    [InlineData("\nread")]
    public void RejectsEmbeddedLineBreaks(string line) =>
        TestHelpers.AssertSdkThrows(ErrorCode.InvalidArgument, () => Protocol.CheckRequestLine(line));
}
