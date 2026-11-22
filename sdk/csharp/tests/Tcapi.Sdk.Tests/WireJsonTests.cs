using Xunit;

namespace Tcapi.Sdk.Tests;

// Wire-format JSON identity (docs/sdk-api-design.md section 6): snake_case
// keys, lowercase string enums, explicit nulls, decimal integers.

public class WireJsonTests
{
    [Fact]
    public void DeviceInfoNullsAreExplicit()
    {
        var info = new DeviceInfo(
            Uid: "AABBCCDD11223344", DeviceNumber: null, Port: "/dev/ttyACM0",
            Version: null);
        Assert.Equal(
            "{\"uid\":\"AABBCCDD11223344\",\"device_number\":null,"
                + "\"port\":\"/dev/ttyACM0\",\"version\":null}",
            WireJson.Serialize(info));
    }

    [Fact]
    public void TimestampEventHasNoPrecomputedNanoseconds()
    {
        var ev = new TimestampEvent(Inputs: 1, RawCount: 2, RawPhase: 12, SyncActive: true);
        Assert.Equal(
            "{\"inputs\":1,\"raw_count\":2,\"raw_phase\":12,\"sync_active\":true}",
            WireJson.Serialize(ev));
    }

    [Fact]
    public void EnumsSerializeAsLowercaseStrings()
    {
        var status = new PatternStatus(PatternState.Running, Step: 5, Loops: 3, Total: 40);
        Assert.Equal(
            "{\"state\":\"running\",\"step\":5,\"loops\":3,\"total\":40}",
            WireJson.Serialize(status));
        Assert.Equal("\"master_armed\"", WireJson.Serialize(SyncState.MasterArmed));
        Assert.Equal("\"both\"", WireJson.Serialize(EdgeMode.Both));
        Assert.Equal("\"loop\"", WireJson.Serialize(PatternMode.Loop));
    }

    [Fact]
    public void CapabilitiesKeysAndHelpers()
    {
        var caps = new Capabilities(
            Dio: 25, Out: 2, In: 23, TsResNs: 40, TickNs: 200, PatternMax: 256, Ring: 256,
            Features: 3);
        var json = WireJson.Serialize(caps);
        Assert.Equal(
            "{\"dio\":25,\"out\":2,\"in\":23,\"ts_res_ns\":40,\"tick_ns\":200,"
                + "\"pattern_max\":256,\"ring\":256,\"features\":3}",
            json);
        Assert.DoesNotContain("has_sync", json);
        Assert.Equal(caps, WireJson.Deserialize<Capabilities>(json));
    }

    [Fact]
    public void PinMapMatchesTheDocumentedExample()
    {
        // docs/sdk-api-design.md section 6, the `map get` result.
        const string json =
            "{\"flags\":0,\"direction\":15,\"pull_up\":240,\"pull_down\":209714944,"
            + "\"out_default\":5,\"out_polarity\":8,\"in_polarity\":256,\"edge\":209715184}";
        Assert.Equal(json, WireJson.Serialize(PinMapTests.DocMap));
        Assert.Equal(PinMapTests.DocMap, WireJson.Deserialize<PinMap>(json));
    }

    [Fact]
    public void PatternStepAndIoStateKeys()
    {
        Assert.Equal(
            "{\"out_bits\":1,\"hold_ticks\":5}", WireJson.Serialize(new PatternStep(1, 5)));
        Assert.Equal("{\"inputs\":3,\"outputs\":4}", WireJson.Serialize(new IoState(3, 4)));
        Assert.Equal(
            "{\"armed\":true,\"pending\":2,\"overflow\":false}",
            WireJson.Serialize(new TsStatus(true, 2, false)));
    }

    [Fact]
    public void TimestampResultMatchesTheDocumentedExample()
    {
        // The `ts get` result of the golden sync transcript (docs section 6).
        const string json =
            "{\"events\":["
            + "{\"inputs\":1,\"raw_count\":2,\"raw_phase\":12,\"sync_active\":true},"
            + "{\"inputs\":0,\"raw_count\":3,\"raw_phase\":24,\"sync_active\":true},"
            + "{\"inputs\":1,\"raw_count\":4,\"raw_phase\":0,\"sync_active\":true},"
            + "{\"inputs\":0,\"raw_count\":107,\"raw_phase\":0,\"sync_active\":false}],"
            + "\"overflow\":false}";
        var response = GoldenCorpus.Case("timestamp", "ts under sync").Steps
            .Last(s => s.Text.StartsWith("ts get", StringComparison.Ordinal)).Response;
        var (_, overflow) = Protocol.ParseTsGetHeader(response[0][3..]);
        var parsed = new TimestampResult(
            response.Skip(1).Select(Protocol.ParseTsEventLine).ToList(), overflow);

        Assert.Equal(json, WireJson.Serialize(parsed));
        var restored = WireJson.Deserialize<TimestampResult>(json);
        Assert.Equal(parsed.Events.ToList(), restored.Events.ToList());
        Assert.Equal(2480, restored.Events[0].Ns(40));
    }

    [Fact]
    public void RoundTrip()
    {
        var original = new TimestampResult(
            Events:
            [
                new TimestampEvent(5, 1000, 7, true),
                new TimestampEvent(10, 2000, 12, false),
            ],
            Overflow: true);
        var restored = WireJson.Deserialize<TimestampResult>(WireJson.Serialize(original));
        Assert.Equal(original.Overflow, restored.Overflow);
        Assert.Equal(original.Events.ToList(), restored.Events.ToList());
    }

    [Fact]
    public void PairStatsKeepsPythonFieldName()
    {
        var stats = new PairStats(
            A: "GP0", B: "GP1", N: 1, MeanDiffNs: 200.0, StdevNs: 0.0,
            MaxAbsDiffNs: 200, Within500NsPct: 100.0);
        Assert.Contains("\"within_500ns_pct\":100", WireJson.Serialize(stats));
    }

    [Fact]
    [Trait("Category", "Negative")]
    public void InvalidJsonIsParseError()
    {
        TestHelpers.AssertSdkThrows(ErrorCode.Parse,
            () => WireJson.Deserialize<DeviceInfo>("{nope"));
        TestHelpers.AssertSdkThrows(ErrorCode.Parse,
            () => WireJson.Deserialize<DeviceInfo>("null"));
    }

    [Fact]
    [Trait("Category", "Negative")]
    public void UnregisteredTypeIsRejectedNotReflected()
    {
        // Source generation only knows the wire types; an unknown type must
        // fail loudly instead of silently falling back to reflection.
        TestHelpers.AssertSdkThrows(ErrorCode.InvalidArgument,
            () => WireJson.Serialize(new Uri("http://example.invalid/")));
        TestHelpers.AssertSdkThrows(ErrorCode.InvalidArgument,
            () => WireJson.Deserialize<Version>("{}"));
    }
}
