using Xunit;

namespace Pochi.Sdk.Tests;

// Wire-format JSON identity (docs/sdk-api-design.md §6): snake_case keys,
// lowercase string enums, explicit nulls, decimal integers.

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
    public void TimestampEventSnakeCaseKeys()
    {
        var ev = new TimestampEvent(
            Inputs: 5, RawCount: 1000, RawPhase: 7, SyncActive: true,
            TimestampNs: 1000280);
        Assert.Equal(
            "{\"inputs\":5,\"raw_count\":1000,\"raw_phase\":7,"
                + "\"sync_active\":true,\"timestamp_ns\":1000280}",
            WireJson.Serialize(ev));
    }

    [Fact]
    public void EnumsSerializeAsLowercaseStrings()
    {
        var status = new PatternStatus(
            State: PatternState.Running, CurrentStep: 5, LoopsDone: 3);
        Assert.Equal(
            "{\"state\":\"running\",\"current_step\":5,\"loops_done\":3}",
            WireJson.Serialize(status));

        var map = new PinMap(
            Version: 1, OutBase: 0, OutCount: 12, InBase: 12, InCount: 11,
            Pull: PullMode.Up, Flags: 1);
        Assert.Contains("\"pull\":\"up\"", WireJson.Serialize(map));
        Assert.Equal("\"master_armed\"", WireJson.Serialize(SyncState.MasterArmed));
    }

    [Fact]
    public void CapabilitiesHelperIsNotSerialized()
    {
        var caps = new Capabilities(
            ProtocolVersion: 1, MaxDio: 23, OutCount: 12, InCount: 11,
            TsResolutionNs: 40, MaxPatternSteps: 256, TsRingEvents: 256,
            Features: 1);
        var json = WireJson.Serialize(caps);
        Assert.DoesNotContain("has_sync", json);
        Assert.Contains("\"ts_resolution_ns\":40", json);
    }

    [Fact]
    public void RoundTrip()
    {
        var original = new TimestampResult(
            Events:
            [
                new TimestampEvent(5, 1000, 7, true, 1000280),
                new TimestampEvent(10, 2000, 12, false, 2000480),
            ],
            Reconciled: false,
            Overflow: true);
        var restored = WireJson.Deserialize<TimestampResult>(
            WireJson.Serialize(original));
        Assert.Equal(original.Reconciled, restored.Reconciled);
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
    public void InvalidJsonIsParseError()
    {
        TestHelpers.AssertSdkThrows(ErrorCode.Parse,
            () => WireJson.Deserialize<DeviceInfo>("{nope"));
        TestHelpers.AssertSdkThrows(ErrorCode.Parse,
            () => WireJson.Deserialize<DeviceInfo>("null"));
    }
}
