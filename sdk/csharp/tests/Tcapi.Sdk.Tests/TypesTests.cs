using Xunit;

namespace Tcapi.Sdk.Tests;

// v2 types (docs/sdk-api-design.md section 2): pin convention, PinMap,
// PatternStep, Capabilities, TimestampEvent.

public class PinConventionTests
{
    [Fact]
    public void Constants()
    {
        Assert.Equal(2, Pins.ProtoVersion);
        Assert.Equal(25, Pins.DioChannels);
        Assert.Equal(0x0C7F_FFFFU, Pins.ValidDioMask);
        Assert.Equal(200U, Pins.PatternTickNs);
    }

    [Theory]
    [InlineData(0, 0)]
    [InlineData(1, 1)]
    [InlineData(22, 22)]
    [InlineData(23, 26)]
    [InlineData(24, 27)]
    public void ChToGp(byte ch, byte gp) => Assert.Equal(gp, Pins.ChToGp(ch));

    [Theory]
    [InlineData(25)]
    [InlineData(26)]
    [InlineData(255)]
    public void ChToGpRejectsOutOfRange(byte ch) =>
        TestHelpers.AssertSdkThrows(ErrorCode.InvalidArgument, () => Pins.ChToGp(ch));

    [Theory]
    [InlineData(0, 0)]
    [InlineData(22, 22)]
    [InlineData(26, 23)]
    [InlineData(27, 24)]
    public void GpToCh(byte gp, byte ch) => Assert.Equal(ch, Pins.GpToCh(gp));

    [Theory]
    [InlineData(23)]
    [InlineData(24)]
    [InlineData(25)]
    [InlineData(28)]
    [InlineData(29)]
    [InlineData(255)]
    public void GpToChRejectsNonDioPins(byte gp) =>
        TestHelpers.AssertSdkThrows(ErrorCode.InvalidArgument, () => Pins.GpToCh(gp));

    [Fact]
    public void ChannelsRoundTripAndCoverTheValidMask()
    {
        uint mask = 0;
        for (byte ch = 0; ch < Pins.DioChannels; ch++)
        {
            var gp = Pins.ChToGp(ch);
            Assert.Equal(ch, Pins.GpToCh(gp));
            mask |= 1U << gp;
        }

        Assert.Equal(Pins.ValidDioMask, mask);
    }

    [Theory]
    [InlineData(0, "GP0 (ch0)")]
    [InlineData(22, "GP22 (ch22)")]
    [InlineData(26, "GP26 (ch23)")]
    [InlineData(27, "GP27 (ch24)")]
    public void PinLabel(byte gp, string label) => Assert.Equal(label, Pins.PinLabel(gp));

    [Fact]
    public void PinLabelRejectsNonDioPin() =>
        TestHelpers.AssertSdkThrows(ErrorCode.InvalidArgument, () => Pins.PinLabel(23));

    [Fact]
    public void CheckDioMask()
    {
        Pins.CheckDioMask("m", 0);
        Pins.CheckDioMask("m", Pins.ValidDioMask);
        foreach (var gp in new[] { 23, 24, 25, 28, 31 })
        {
            var ex = TestHelpers.AssertSdkThrows(
                ErrorCode.InvalidArgument, () => Pins.CheckDioMask("mask", 1U << gp));
            Assert.Contains("mask", ex.Message);
        }
    }
}

public class PinMapTests
{
    // The map of docs/sdk-api-design.md section 6 (a `map get` response).
    internal const string DocMapArgs =
        "v=2 flags=0x00 dir=0x0000000f pu=0x000000f0 pd=0x0c7fff00 def=0x00000005 "
        + "opol=0x00000008 ipol=0x00000100 edge=0x0c7ffff0";

    internal static readonly PinMap DocMap = new(
        Flags: 0, Direction: 0x0F, PullUp: 0xF0, PullDown: 0x0C7F_FF00, OutDefault: 0x05,
        OutPolarity: 0x08, InPolarity: 0x100, Edge: 0x0C7F_FFF0);

    [Fact]
    public void DefaultIsAllInputsWithPullDownAndEdge()
    {
        var map = PinMap.Default;
        Assert.Equal(0U, map.Direction);
        Assert.Equal(Pins.ValidDioMask, map.PullDown);
        Assert.Equal(Pins.ValidDioMask, map.Edge);
        Assert.Equal(0U, map.PullUp | map.OutDefault | map.OutPolarity | map.InPolarity);
        map.Validate();
    }

    [Fact]
    public void ParseGetAndToSetArgsRoundTrip()
    {
        var map = PinMap.ParseGet(DocMapArgs);
        Assert.Equal(DocMap, map);
        Assert.Equal(DocMapArgs, map.ToSetArgs());
    }

    [Fact]
    public void DefaultMapEncodesLikeMapDefaultResponse()
    {
        // The `map get` response after `map default`, as recorded in the golden files.
        const string data =
            "v=2 flags=0x00 dir=0x00000000 pu=0x00000000 pd=0x0c7fffff def=0x00000000 "
            + "opol=0x00000000 ipol=0x00000000 edge=0x0c7fffff";
        Assert.Equal(data, PinMap.Default.ToSetArgs());
        Assert.Contains(
            "OK " + data,
            GoldenCorpus.Cases.SelectMany(c => c.Steps).SelectMany(s => s.Response));
    }

    [Fact]
    public void ValidMapsPass()
    {
        DocMap.Validate();
        new PinMap(0, Pins.ValidDioMask, 0, 0, Pins.ValidDioMask, Pins.ValidDioMask, 0, 0)
            .Validate();
    }

    public static IEnumerable<object[]> Violations()
    {
        var ok = DocMap;
        yield return ["flags", ok with { Flags = 1 }];
        yield return ["direction", ok with { Direction = 0x0080_000F }];
        yield return ["pull_up", ok with { PullUp = 0x1 }]; // pin 0 is an output
        yield return ["pull_up", ok with { PullUp = 0x0080_0000 }]; // not a DIO pin
        yield return ["pull_down", ok with { PullDown = 0x2 }];
        yield return ["pull_up & pull_down", ok with { PullUp = 0x10, PullDown = 0x10 }];
        yield return ["out_default", ok with { OutDefault = 0x10 }];
        yield return ["out_polarity", ok with { OutPolarity = 0x10 }];
        yield return ["in_polarity", ok with { InPolarity = 0x1 }];
        yield return ["edge", ok with { Edge = 0x1 }];
    }

    [Theory]
    [MemberData(nameof(Violations))]
    public void ValidateNamesTheViolatedField(string field, PinMap map)
    {
        var ex = TestHelpers.AssertSdkThrows(ErrorCode.InvalidArgument, map.Validate);
        Assert.Contains(field, ex.Message);
    }

    [Fact]
    public void ToSetArgsRefusesAnInvalidMap() =>
        TestHelpers.AssertSdkThrows(
            ErrorCode.InvalidArgument, () => (DocMap with { Flags = 1 }).ToSetArgs());

    [Fact]
    public void ParseGetRejectsAMapTheFirmwareWouldRefuse() =>
        TestHelpers.AssertSdkThrows(
            ErrorCode.Parse,
            () => PinMap.ParseGet(DocMapArgs.Replace("dir=0x0000000f", "dir=0x0080000f")));
}

public class PatternStepTests
{
    [Fact]
    public void ToTextIsThePatternAddForm()
    {
        Assert.Equal("0x1:5", new PatternStep(1, 5).ToText());
        Assert.Equal("0x0:1", new PatternStep(0, 1).ToText());
        Assert.Equal("0xc7fffff:4294967295", new PatternStep(0xC7F_FFFF, uint.MaxValue).ToText());
    }

    [Fact]
    public void ValidateRejectsZeroHoldAndNonDioBits()
    {
        TestHelpers.AssertSdkThrows(
            ErrorCode.InvalidArgument, () => new PatternStep(1, 0).Validate());
        TestHelpers.AssertSdkThrows(
            ErrorCode.InvalidArgument, () => new PatternStep(0x0080_0000, 1).ToText());
    }

    [Fact]
    public void HoldNsIsTicksTimes200() =>
        Assert.Equal(1_000UL, new PatternStep(0, 5).HoldNs());

    [Fact]
    public void HoldNsDoesNotOverflow() =>
        Assert.Equal(uint.MaxValue * 200UL, new PatternStep(0, uint.MaxValue).HoldNs());

    [Theory]
    [InlineData(200UL, 1U)]
    [InlineData(1_000UL, 5U)]
    [InlineData(200_000UL, 1_000U)]
    [InlineData(uint.MaxValue * 200UL, uint.MaxValue)]
    public void HoldTicksFromNsAcceptsExactMultiples(ulong ns, uint ticks) =>
        Assert.Equal(ticks, PatternStep.HoldTicksFromNs(ns));

    [Theory]
    [InlineData(0UL)]
    [InlineData(199UL)]
    [InlineData(201UL)]
    [InlineData(1_001UL)]
    [InlineData((uint.MaxValue + 1UL) * 200UL)]
    [InlineData(ulong.MaxValue)]
    public void HoldTicksFromNsNeverRounds(ulong ns) =>
        TestHelpers.AssertSdkThrows(
            ErrorCode.InvalidArgument, () => PatternStep.HoldTicksFromNs(ns));
}

public class CapabilitiesTests
{
    private static Capabilities WithFeatures(uint features) =>
        new(Dio: 25, Out: 2, In: 23, TsResNs: 40, TickNs: 200, PatternMax: 256, Ring: 256,
            Features: features);

    [Fact]
    public void SyncAndResetFeatureBits()
    {
        Assert.False(WithFeatures(0x1).HasReset);
        Assert.True(WithFeatures(0x1).HasSync);
        Assert.True(WithFeatures(0x2).HasReset);
        Assert.False(WithFeatures(0x2).HasSync);
        Assert.True(WithFeatures(0x3).HasSync && WithFeatures(0x3).HasReset);
        Assert.False(WithFeatures(0).HasSync || WithFeatures(0).HasReset);
    }
}

public class TimestampEventTests
{
    [Fact]
    public void NsUsesTheResolutionFromCaps()
    {
        // The first event of the golden sync timestamp transcript: c=2 p=12 s=1.
        var ev = new TimestampEvent(Inputs: 1, RawCount: 2, RawPhase: 12, SyncActive: true);
        Assert.Equal(2 * 1000 + 12 * 40, ev.Ns(40));
        Assert.Equal(2 * 1000 + 12 * 50, ev.Ns(50));
    }

    [Fact]
    public void FreeRunningCountIsMicroseconds()
    {
        // A non-zero phase must be ignored when the sync clock is not running.
        var ev = new TimestampEvent(Inputs: 0, RawCount: 107, RawPhase: 5, SyncActive: false);
        Assert.Equal(107_000, ev.Ns(40));
    }

    [Fact]
    public void LargestCountDoesNotOverflow()
    {
        var ev = new TimestampEvent(0, uint.MaxValue, 24, true);
        Assert.Equal(uint.MaxValue * 1000L + 24 * 40, ev.Ns(40));
    }
}
