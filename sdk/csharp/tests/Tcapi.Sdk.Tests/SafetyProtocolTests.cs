using Xunit;

namespace Tcapi.Sdk.Tests;

// Command builders, response parsers, typed errors, the FAILSAFE event and
// the feature bits of the safety functions (docs/sdk-api-design.md,
// "Safety Commands"). The lines here are parser inputs; the golden
// conformance of the same parsers is in GoldenReplayTests.

public class FeatureBitTests
{
    private static Capabilities WithFeatures(uint features) =>
        new(Dio: 25, Out: 2, In: 23, TsResNs: 40, TickNs: 200, PatternMax: 256, Ring: 256,
            Features: features);

    [Fact]
    public void EveryBitHasItsConstant()
    {
        Assert.Equal(0x01U, (uint)Feature.Sync);
        Assert.Equal(0x02U, (uint)Feature.Reset);
        Assert.Equal(0x04U, (uint)Feature.Wdog);
        Assert.Equal(0x08U, (uint)Feature.Excl);
        Assert.Equal(0x10U, (uint)Feature.OutReset);
        Assert.Equal(0x20U, (uint)Feature.RstInfo);
        Assert.Equal(0x40U, (uint)Feature.UsbSafe);
        Assert.Equal(0x80U, (uint)Feature.Pads);
        Assert.Equal(0xffU, FeatureBits.Mask);
        Assert.Equal(8, FeatureBits.All.Count);
        Assert.Equal(FeatureBits.Mask, FeatureBits.All.Aggregate(0U, (m, f) => m | (uint)f));
    }

    [Fact]
    public void HasTestsOneBit()
    {
        var caps = WithFeatures(0x03);
        Assert.True(caps.Has(Feature.Sync));
        Assert.True(caps.Has(Feature.Reset));
        Assert.False(caps.Has(Feature.Wdog));
        Assert.True(caps.HasSync);
        Assert.True(caps.HasReset);
        Assert.True(WithFeatures(0xff).Has(Feature.Pads));
        Assert.False(WithFeatures(0).Has(Feature.Sync));
    }

    [Fact]
    public void FeatureListIsInBitOrderAndIgnoresUndefinedBits()
    {
        Assert.Equal(
            [Feature.Reset, Feature.Excl, Feature.Pads],
            WithFeatures(0x8a).FeatureList());
        Assert.Empty(WithFeatures(0).FeatureList());
        Assert.Equal(FeatureBits.All, WithFeatures(0xffff_ffff).FeatureList());
    }
}

public class SafetyCommandTests
{
    [Theory]
    [InlineData(0U, "wdog 0")]
    [InlineData(100U, "wdog 100")]
    [InlineData(10000U, "wdog 10000")]
    public void WdogAcceptsZeroAndTheRange(uint ms, string line) =>
        Assert.Equal(line, Protocol.WdogCommand(ms));

    [Theory]
    [InlineData(1U)]
    [InlineData(99U)]
    [InlineData(10001U)]
    [InlineData(uint.MaxValue)]
    public void WdogRefusesTheRestBeforeSending(uint ms) =>
        TestHelpers.AssertSdkThrows(ErrorCode.InvalidArgument, () => Protocol.WdogCommand(ms));

    [Fact]
    public void UsbsafeSpellsOnAndOff()
    {
        Assert.Equal("usbsafe on", Protocol.UsbsafeCommand(true));
        Assert.Equal("usbsafe off", Protocol.UsbsafeCommand(false));
    }

    [Fact]
    public void ExclSetListsMasksInLowerCaseHex()
    {
        Assert.Equal("excl set 0xc", Protocol.ExclSetCommand([0xc]));
        Assert.Equal("excl set 0xc 0x18", Protocol.ExclSetCommand([0xc, 0x18]));
        Assert.Equal(
            "excl set 0xc400000 0x400001", Protocol.ExclSetCommand([0x0c40_0000, 0x0040_0001]));
        // The maximum of 16 groups.
        var sixteen = Enumerable.Range(0, 16).Select(i => 3U << i).ToArray();
        Assert.StartsWith("excl set 0x3 0x6", Protocol.ExclSetCommand(sixteen), StringComparison.Ordinal);
    }

    [Fact]
    public void ExclSetRefusesWhatTheDeviceWouldRefuse()
    {
        void Refused(params uint[] masks) =>
            TestHelpers.AssertSdkThrows(
                ErrorCode.InvalidArgument, () => Protocol.ExclSetCommand(masks));

        Refused(); // no group
        Refused(Enumerable.Range(0, 17).Select(i => 3U << (i % 16)).ToArray()); // 17 groups
        Refused(0); // no pin
        Refused(0x1); // one pin
        Refused(0x8000_0003); // a bit outside the DIO pins
        Refused(0x0080_0001); // GP23 is not a DIO pin
        Refused(0x3, 0x1); // the second group has one pin
    }
}

public class SafetyParserTests
{
    [Fact]
    public void SafetyParsesEveryGoldenShape()
    {
        Assert.Equal(
            new SafetyState(0, 0, false, FailsafeCause.None, false, 0),
            Protocol.ParseSafety("wdog_ms=0 remaining_ms=0 failsafe=0 cause=none usbsafe=0 excl=0"));
        Assert.Equal(
            new SafetyState(500, 377, false, FailsafeCause.None, true, 16),
            Protocol.ParseSafety(
                "wdog_ms=500 remaining_ms=377 failsafe=0 cause=none usbsafe=1 excl=16"));
        Assert.Equal(
            new SafetyState(100, 0, true, FailsafeCause.Wdog, false, 0),
            Protocol.ParseSafety("wdog_ms=100 remaining_ms=0 failsafe=1 cause=wdog usbsafe=0 excl=0"));
        Assert.Equal(
            new SafetyState(0, 0, true, FailsafeCause.Usb, true, 0),
            Protocol.ParseSafety("wdog_ms=0 remaining_ms=0 failsafe=1 cause=usb usbsafe=1 excl=0"));
    }

    [Fact]
    public void SafetyKeyOrderIsFree() =>
        Assert.Equal(
            new SafetyState(100, 50, false, FailsafeCause.None, false, 2),
            Protocol.ParseSafety("excl=2 usbsafe=0 cause=none failsafe=0 remaining_ms=50 wdog_ms=100"));

    [Theory]
    [Trait("Category", "Negative")]
    [InlineData("wdog_ms=0 remaining_ms=0 failsafe=0 cause=none usbsafe=0")] // missing key
    [InlineData("wdog_ms=0 remaining_ms=0 failsafe=0 cause=none usbsafe=0 excl=0 extra=1")]
    [InlineData("wdog_ms=x remaining_ms=0 failsafe=0 cause=none usbsafe=0 excl=0")]
    [InlineData("wdog_ms=0 remaining_ms=0 failsafe=2 cause=none usbsafe=0 excl=0")]
    [InlineData("wdog_ms=0 remaining_ms=0 failsafe=0 cause=other usbsafe=0 excl=0")]
    [InlineData("wdog_ms=0 remaining_ms=0 failsafe=0 cause=NONE usbsafe=0 excl=0")]
    [InlineData("wdog_ms=0 remaining_ms=0 failsafe=0 cause=none usbsafe=0 excl=17")]
    [InlineData("wdog_ms=0 remaining_ms=0 failsafe=0 cause=none usbsafe=0 excl=256")]
    [InlineData("wdog_ms=4294967296 remaining_ms=0 failsafe=0 cause=none usbsafe=0 excl=0")]
    // The latch and the cause must agree.
    [InlineData("wdog_ms=0 remaining_ms=0 failsafe=1 cause=none usbsafe=0 excl=0")]
    [InlineData("wdog_ms=0 remaining_ms=0 failsafe=0 cause=wdog usbsafe=0 excl=0")]
    public void SafetyRejectsMalformedResponses(string data) =>
        TestHelpers.AssertSdkThrows(ErrorCode.Parse, () => Protocol.ParseSafety(data));

    [Theory]
    [InlineData("por", ResetCause.Por)]
    [InlineData("wdt", ResetCause.Wdt)]
    [InlineData("soft", ResetCause.Soft)]
    [InlineData("bor", ResetCause.Bor)]
    [InlineData("other", ResetCause.Other)]
    public void RstinfoParsesEveryCause(string name, ResetCause cause) =>
        Assert.Equal(
            new ResetInfo(cause, 5000, 2),
            Protocol.ParseRstinfo($"cause={name} uptime_ms=5000 boot=0x00000002"));

    [Fact]
    public void RstinfoUptimeIsU64AndBootIsAMask() =>
        Assert.Equal(
            new ResetInfo(ResetCause.Por, ulong.MaxValue, 1),
            Protocol.ParseRstinfo("cause=por uptime_ms=18446744073709551615 boot=0x1"));

    [Theory]
    [Trait("Category", "Negative")]
    [InlineData("cause=por uptime_ms=0")]
    [InlineData("cause=por uptime_ms=0 boot=0x1 extra=1")]
    [InlineData("cause=reset uptime_ms=0 boot=0x1")]
    [InlineData("cause=POR uptime_ms=0 boot=0x1")]
    [InlineData("cause=por uptime_ms=-1 boot=0x1")]
    [InlineData("cause=por uptime_ms=18446744073709551616 boot=0x1")]
    [InlineData("cause=por uptime_ms=0 boot=zz")]
    [InlineData("cause=por uptime_ms=0 boot=0x100000000")]
    public void RstinfoRejectsMalformedResponses(string data) =>
        TestHelpers.AssertSdkThrows(ErrorCode.Parse, () => Protocol.ParseRstinfo(data));

    [Fact]
    public void PadsParseInAnyKeyOrder()
    {
        Assert.Equal(
            new Pads(5, 1), Protocol.ParsePads("out=0x00000005 pad=0x00000001"));
        Assert.Equal(new Pads(4, 2), Protocol.ParsePads("pad=0x2 out=0x4"));
    }

    [Theory]
    [Trait("Category", "Negative")]
    [InlineData("out=0x1")]
    [InlineData("out=0x1 pad=0x1 extra=0")]
    [InlineData("out=zz pad=0x1")]
    [InlineData("out=0x1 pad=0x100000000")]
    public void PadsRejectMalformedResponses(string data) =>
        TestHelpers.AssertSdkThrows(ErrorCode.Parse, () => Protocol.ParsePads(data));

    [Fact]
    public void ExclGetReadsTheCountedMasksInOrder()
    {
        Assert.Equal(
            [0xcU, 0x18U],
            Protocol.ParseExclGet("count=2", ["  mask=0x0000000c", "  mask=0x00000018"]));
        Assert.Empty(Protocol.ParseExclGet("count=0", []));
    }

    [Theory]
    [Trait("Category", "Negative")]
    [InlineData("count=2", "  mask=0x0000000c")] // fewer lines than announced
    [InlineData("count=0", "  mask=0x0000000c")] // more lines than announced
    [InlineData("count=1", "  mask=zz")]
    [InlineData("count=1", "  mask=0x1 extra=1")]
    [InlineData("count=1", "  pad=0x1")]
    [InlineData("n=1", "  mask=0x1")]
    [InlineData("count=1 extra=1", "  mask=0x1")]
    public void ExclGetRejectsInconsistentResponses(string header, string line) =>
        TestHelpers.AssertSdkThrows(
            ErrorCode.Parse, () => Protocol.ParseExclGet(header, [line]));

    [Fact]
    public void ExclGetRejectsMoreThanSixteenGroups()
    {
        var lines = Enumerable.Range(0, 17).Select(_ => "  mask=0x00000003").ToArray();
        TestHelpers.AssertSdkThrows(
            ErrorCode.Parse, () => Protocol.ParseExclGet("count=17", lines));
        Assert.Equal(16, Protocol.ParseExclGet("count=16", lines[..16]).Count);
    }
}

public class SafetyErrorTests
{
    [Fact]
    public void FailsafeIsTyped()
    {
        var ex = TestHelpers.AssertSdkThrows(
            ErrorCode.Failsafe, () => new Response(ResponseKind.Err, "FAILSAFE").OkData());
        Assert.IsNotType<ExclusiveException>(ex);
    }

    [Fact]
    public void ExclusiveCarriesGroupAndMask()
    {
        var ex = Assert.IsType<ExclusiveException>(
            SdkException.FromDeviceError("EXCLUSIVE group=1 mask=0x0000000c"));
        Assert.Equal(ErrorCode.Exclusive, ex.Code);
        Assert.Equal((byte)1, ex.Group);
        Assert.Equal(0xcU, ex.Mask);
        Assert.Contains("group 1", ex.Message, StringComparison.Ordinal);
        Assert.Contains("0x0000000c", ex.Message, StringComparison.Ordinal);

        // Token order is free, a decimal mask is accepted and extra tokens are ignored.
        ex = Assert.IsType<ExclusiveException>(
            SdkException.FromDeviceError("EXCLUSIVE mask=7 extra=zz group=15 more=1"));
        Assert.Equal(((byte)15, 7U), (ex.Group, ex.Mask));

        // A repeated key keeps its first value (as the Rust SDK does).
        ex = Assert.IsType<ExclusiveException>(
            SdkException.FromDeviceError("EXCLUSIVE group=2 group=3 mask=0x3 mask=0x5"));
        Assert.Equal(((byte)2, 3U), (ex.Group, ex.Mask));

        // It is raised by the response path.
        var raised = Assert.Throws<ExclusiveException>(
            () => new Response(ResponseKind.Err, "EXCLUSIVE group=0 mask=0x0000000c").OkData());
        Assert.Equal(((byte)0, 0xcU), (raised.Group, raised.Mask));
    }

    [Theory]
    [Trait("Category", "Negative")]
    [InlineData("EXCLUSIVE")]
    [InlineData("EXCLUSIVE group=0")]
    [InlineData("EXCLUSIVE mask=0x3")]
    [InlineData("EXCLUSIVE group=x mask=0x3")]
    [InlineData("EXCLUSIVE group=256 mask=0x3")]
    [InlineData("EXCLUSIVE group=-1 mask=0x3")]
    [InlineData("EXCLUSIVE group=0 mask=zz")]
    [InlineData("EXCLUSIVE group=0 mask=0x100000000")]
    public void ExclusiveWithoutValidDataIsAParseErrorNotADefault(string text)
    {
        var ex = SdkException.FromDeviceError(text);
        Assert.Equal(ErrorCode.Parse, ex.Code);
        Assert.IsNotType<ExclusiveException>(ex);
    }

    [Fact]
    public void DataTokensAfterOtherKnownNamesAreIgnored()
    {
        Assert.Equal(ErrorCode.Busy, SdkException.FromDeviceError("BUSY why=now").Code);
        Assert.Equal(ErrorCode.Failsafe, SdkException.FromDeviceError("FAILSAFE cause=wdog").Code);
        // An unknown name keeps the whole text.
        var ex = SdkException.FromDeviceError("WHAT x=1");
        Assert.Equal(ErrorCode.UnknownDevice, ex.Code);
        Assert.Contains("WHAT x=1", ex.Message, StringComparison.Ordinal);
    }
}

public class FailsafeEventTests
{
    [Theory]
    [InlineData("FAILSAFE cause=wdog", FailsafeCause.Wdog)]
    [InlineData("FAILSAFE cause=usb", FailsafeCause.Usb)]
    public void ParsesTheCause(string payload, FailsafeCause cause) =>
        Assert.Equal(new FailsafeEvent(cause), Protocol.ParsePushEvent(payload));

    [Theory]
    [Trait("Category", "Negative")]
    [InlineData("FAILSAFE")]
    [InlineData("FAILSAFE cause=none")] // a trip always has a cause
    [InlineData("FAILSAFE cause=disk")]
    [InlineData("FAILSAFE cause=wdog extra=1")]
    public void RejectsMalformedEvents(string payload) =>
        TestHelpers.AssertSdkThrows(ErrorCode.Parse, () => Protocol.ParsePushEvent(payload));
}

public class SafetyTypesTests
{
    [Fact]
    public void WireJsonUsesTheSharedFieldNames()
    {
        Assert.Equal(
            """{"wdog_ms":500,"remaining_ms":377,"failsafe":false,"cause":"none","usbsafe":true,"excl":2}""",
            WireJson.Serialize(new SafetyState(500, 377, false, FailsafeCause.None, true, 2)));
        Assert.Equal(
            """{"cause":"soft","uptime_ms":12,"boot":3}""",
            WireJson.Serialize(new ResetInfo(ResetCause.Soft, 12, 3)));
        Assert.Equal("""{"out":5,"pad":1}""", WireJson.Serialize(new Pads(5, 1)));
        Assert.Equal(
            """{"watchdog_ms":800,"usbsafe":true,"groups":[12,24]}""",
            WireJson.Serialize(new SafetyConfig(800, true, [0xc, 0x18])));
    }

    [Fact]
    public void WireJsonRoundTrips()
    {
        var state = new SafetyState(100, 0, true, FailsafeCause.Usb, false, 1);
        Assert.Equal(state, WireJson.Deserialize<SafetyState>(WireJson.Serialize(state)));
        var config = new SafetyConfig(250, true, [0xe0]);
        Assert.Equal(config, WireJson.Deserialize<SafetyConfig>(WireJson.Serialize(config)));
    }

    [Fact]
    public void SafetyConfigComparesItsGroupsByValue()
    {
        Assert.Equal(new SafetyConfig(0, false, [3, 6]), new SafetyConfig(0, false, [3, 6]));
        Assert.NotEqual(new SafetyConfig(0, false, [3, 6]), new SafetyConfig(0, false, [6, 3]));
        Assert.Equal(
            new SafetyConfig(0, false, [3]).GetHashCode(),
            new SafetyConfig(0, false, [3]).GetHashCode());
        Assert.Equal(new SafetyConfig(0, false, []), SafetyConfig.Default);
    }

    [Fact]
    public void CommandsFollowTheApplyOrder()
    {
        // DD-16: excl set (or excl clear when there are no groups), usbsafe, wdog.
        Assert.Equal(
            ["excl set 0xc 0x18", "usbsafe on", "wdog 800"],
            new SafetyConfig(800, true, [0xc, 0x18]).Commands());
        Assert.Equal(
            ["excl clear", "usbsafe off", "wdog 0"], SafetyConfig.Default.Commands());
    }

    [Fact]
    public void CommandsRefuseAValueTheDeviceWouldRefuse()
    {
        TestHelpers.AssertSdkThrows(
            ErrorCode.InvalidArgument, () => new SafetyConfig(99, false, []).Commands());
        TestHelpers.AssertSdkThrows(
            ErrorCode.InvalidArgument, () => new SafetyConfig(0, false, [0x1]).Commands());
        TestHelpers.AssertSdkThrows(
            ErrorCode.InvalidArgument,
            () => new SafetyConfig(0, false, Enumerable.Repeat(3U, 17).ToArray()).Commands());
    }
}
