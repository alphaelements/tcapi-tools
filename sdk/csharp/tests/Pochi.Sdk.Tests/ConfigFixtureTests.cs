using System.Globalization;
using Xunit;

namespace Pochi.Sdk.Tests;

// Conformance of Config.ParseSafety against the shared fixtures in
// docs/fixtures (docs/config-files.md section 5): the evaluated settings,
// the apply commands, the exact error message and the reported line must
// equal the `# expected*` comment lines of each file. The C# SDK reads
// safety.toml only; the map-* and pattern-* fixtures belong to parsers it
// does not provide.

internal static class Fixtures
{
    public static string Directory
    {
        get
        {
            for (var dir = new DirectoryInfo(AppContext.BaseDirectory);
                 dir is not null;
                 dir = dir.Parent)
            {
                var candidate = Path.Combine(dir.FullName, "docs", "fixtures");
                if (File.Exists(Path.Combine(candidate, "safety-minimal.toml")))
                {
                    return candidate;
                }
            }

            throw new DirectoryNotFoundException(
                "docs/fixtures not found above " + AppContext.BaseDirectory);
        }
    }

    public static IEnumerable<string> Names(string prefix) =>
        System.IO.Directory.GetFiles(Directory, prefix + "*.toml")
            .Select(Path.GetFileName)
            .Order(StringComparer.Ordinal)!;

    public static List<string> Annotations(string src, string key)
    {
        var prefix = $"# {key}:";
        return src.Split('\n')
            .Select(l => l.TrimEnd('\r'))
            .Where(l => l.StartsWith(prefix, StringComparison.Ordinal))
            .Select(l => l[prefix.Length..].Trim())
            .ToList();
    }
}

public class ConfigFixtureTests
{
    public static IEnumerable<object[]> SafetyFixtures() =>
        Fixtures.Names("safety-").Select(n => new object[] { n });

    private static string Summary(SafetyConfig c)
    {
        var groups = c.Groups.Count == 0
            ? "none"
            : string.Join(',', c.Groups.Select(m => $"0x{m:x8}"));
        return string.Create(
            CultureInfo.InvariantCulture,
            $"watchdog_ms={c.WatchdogMs} usbsafe={(c.UsbSafe ? 1 : 0)} groups={groups}");
    }

    [Fact]
    public void ThereAre38SafetyFixtures() =>
        Assert.Equal(38, Fixtures.Names("safety-").Count());

    [Theory]
    [MemberData(nameof(SafetyFixtures))]
    public void EveryFixtureGivesTheDocumentedResult(string name)
    {
        var src = File.ReadAllText(Path.Combine(Fixtures.Directory, name));
        var exact = Fixtures.Annotations(src, "expected_error");
        var prefix = Fixtures.Annotations(src, "expected_error_prefix");
        if (exact.Count + prefix.Count == 0)
        {
            var config = Config.ParseSafety(src, name);
            Assert.Equal([Summary(config)], Fixtures.Annotations(src, "expected"));
            Assert.Equal(Fixtures.Annotations(src, "expected_command"), config.Commands());
            return;
        }

        Assert.Equal(1, exact.Count + prefix.Count);
        var ex = Assert.Throws<ConfigException>(() => Config.ParseSafety(src, name));
        if (exact.Count == 1)
        {
            Assert.Equal(exact[0], ex.Detail);
        }
        else
        {
            Assert.StartsWith(prefix[0], ex.Detail, StringComparison.Ordinal);
        }

        Assert.Equal(int.Parse(Fixtures.Annotations(src, "expected_line")[0], CultureInfo.InvariantCulture), ex.Line);
        Assert.Equal(name, ex.File);
        Assert.Equal($"{name}:{ex.Line}: {ex.Detail}", ex.Message);
        Assert.Equal(ErrorCode.Parse, ex.Code);
    }

    [Fact]
    public void TheOtherFixtureKindsAreNotThisParsersBusiness()
    {
        // The set is shared with the parsers of map.toml and pattern.toml;
        // keep the count honest so a new family is noticed.
        Assert.True(Fixtures.Names("map-").Any());
        Assert.True(Fixtures.Names("pattern-").Any());
        var all = System.IO.Directory.GetFiles(Fixtures.Directory, "*.toml")
            .Select(Path.GetFileName)
            .Count(n => !n!.StartsWith("map-", StringComparison.Ordinal)
                && !n.StartsWith("pattern-", StringComparison.Ordinal)
                && !n.StartsWith("safety-", StringComparison.Ordinal));
        Assert.Equal(0, all);
    }
}

public class ConfigTests
{
    [Fact]
    public void AFileWithOnlyTheVersionIsAllOff() =>
        Assert.Equal(SafetyConfig.Default, Config.ParseSafety("version = 2\n", "s.toml"));

    [Fact]
    public void EmptyInputIsAnErrorNotADefault()
    {
        var ex = Assert.Throws<ConfigException>(() => Config.ParseSafety("", "s.toml"));
        Assert.Equal(("missing key \"version\"", 1), (ex.Detail, ex.Line));
    }

    [Fact]
    public void SyntaxErrorsKeepTheLineOfTheParser()
    {
        var ex = Assert.Throws<ConfigException>(
            () => Config.ParseSafety("version = 2\nwatchdog = \n", "s.toml"));
        Assert.StartsWith("toml syntax: ", ex.Detail, StringComparison.Ordinal);
        Assert.Equal(2, ex.Line);
    }

    [Fact]
    public void MapAndPatternKeysAreUnknownKeys()
    {
        var ex = Assert.Throws<ConfigException>(
            () => Config.ParseSafety("version = 2\n[pins]\n", "s.toml"));
        Assert.Equal(("unknown key \"pins\"", 2), (ex.Detail, ex.Line));
        ex = Assert.Throws<ConfigException>(
            () => Config.ParseSafety("version = 2\n[[step]]\nhold = 1\n", "s.toml"));
        Assert.Equal("unknown key \"step\"", ex.Detail);
    }

    [Fact]
    public void SeveralUnknownKeysReportTheFirstInSortedOrderLikeRust()
    {
        // File order is zeta, alpha; Rust's table (and Python/TS) visits
        // keys sorted, so "alpha" is the reported one in every SDK.
        var ex = Assert.Throws<ConfigException>(
            () => Config.ParseSafety("version = 2\nzeta = 1\nalpha = 2\n", "s.toml"));
        Assert.Equal(("unknown key \"alpha\"", 3), (ex.Detail, ex.Line));
        ex = Assert.Throws<ConfigException>(
            () => Config.ParseSafety("version = 2\n[watchdog]\nzz = 1\naa = 2\n", "s.toml"));
        Assert.Equal(("unknown key \"aa\" in watchdog", 4), (ex.Detail, ex.Line));
        ex = Assert.Throws<ConfigException>(
            () => Config.ParseSafety(
                "version = 2\n[[exclusive]]\npins = [\"GP1\", \"GP2\"]\nzz = 1\naa = 2\n", "s.toml"));
        Assert.Equal(("unknown key \"aa\" in exclusive group 1", 5), (ex.Detail, ex.Line));
    }

    [Fact]
    public void ABomAndCrLfDoNotChangeTheResult()
    {
        var src = "﻿version = 2\r\n\r\n[watchdog]\r\ntimeout_ms = 300\r\n\r\n[[exclusive]]\r\npins = [\"GP1\", \"GP2\"]\r\n";
        Assert.Equal(new SafetyConfig(300, false, [0x6]), Config.ParseSafety(src, "s.toml"));
    }

    [Theory]
    [InlineData("GP0", 0)]
    [InlineData("GP22", 22)]
    [InlineData("GP26", 26)]
    [InlineData("GP27", 27)]
    public void ValidPinNames(string pin, int bit)
    {
        var src = $"version = 2\n[[exclusive]]\npins = [\"{pin}\", \"GP1\"]\n";
        var expected = (1U << bit) | 2U;
        Assert.Equal([expected], Config.ParseSafety(src, "s").Groups);
    }

    [Theory]
    [InlineData("GP23")]
    [InlineData("GP24")]
    [InlineData("GP25")]
    [InlineData("GP28")]
    [InlineData("GP00")]
    [InlineData("GP01")]
    [InlineData("GP+5")]
    [InlineData("gp1")]
    [InlineData("GP")]
    [InlineData("GP-1")]
    [InlineData("GP 1")]
    [InlineData("GP١")] // an Arabic-Indic digit
    [InlineData("GP99999999999999999999")]
    [InlineData("")]
    public void InvalidPinNames(string pin)
    {
        var src = $"version = 2\n[[exclusive]]\npins = [\"{pin}\", \"GP1\"]\n";
        var ex = Assert.Throws<ConfigException>(() => Config.ParseSafety(src, "s"));
        Assert.Equal($"exclusive group 1: invalid pin \"{pin}\" in pins", ex.Detail);
        Assert.Equal(3, ex.Line);
    }

    [Fact]
    public void ALargeIntegerIsRangeCheckedNotWrapped()
    {
        var ex = Assert.Throws<ConfigException>(() => Config.ParseSafety(
            "version = 2\n[watchdog]\ntimeout_ms = 4294967396\n", "s"));
        Assert.Equal("watchdog.timeout_ms must be 0 or between 100 and 10000", ex.Detail);
    }

    [Fact]
    public void ErrorLinesOfMultiLinePinArraysPointAtTheKey()
    {
        var src = "version = 2\n[[exclusive]]\npins = [\n  \"GP1\",\n  \"GP1\",\n]\n";
        var ex = Assert.Throws<ConfigException>(() => Config.ParseSafety(src, "s"));
        Assert.Equal(("exclusive group 1: duplicate pin \"GP1\" in pins", 3), (ex.Detail, ex.Line));
    }

    [Fact]
    public void FloatsAndDatesAreTheWrongTypeNotSyntaxErrors()
    {
        var ex = Assert.Throws<ConfigException>(() => Config.ParseSafety(
            "version = 2\n[watchdog]\ntimeout_ms = 1.5\n", "s"));
        Assert.Equal("watchdog.timeout_ms must be an integer", ex.Detail);
        ex = Assert.Throws<ConfigException>(() => Config.ParseSafety("version = 2020-01-01\n", "s"));
        Assert.Equal("version must be an integer", ex.Detail);
    }

    [Fact]
    public void LoadReadsAFileAndNamesItInErrors()
    {
        var dir = Fixtures.Directory;
        var config = Config.LoadSafety(Path.Combine(dir, "safety-full.toml"));
        Assert.Equal(new SafetyConfig(800, true, [0xc, 0x18]), config);

        var bad = Path.Combine(dir, "safety-watchdog-zero.toml");
        Assert.Equal(SafetyConfig.Default, Config.LoadSafety(bad));
        var ex = Assert.Throws<ConfigException>(
            () => Config.LoadSafety(Path.Combine(dir, "safety-invalid-version.toml")));
        Assert.Contains("safety-invalid-version.toml:4:", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void LoadOfAMissingFileIsAnIoError()
    {
        var path = Path.Combine(Fixtures.Directory, "no-such-file.toml");
        TestHelpers.AssertSdkThrows(ErrorCode.Io, () => Config.LoadSafety(path));
    }

    [Fact]
    public void InvalidUtf8IsAnError()
    {
        var path = Path.Combine(Path.GetTempPath(), $"pochi-bad-{Guid.NewGuid():N}.toml");
        File.WriteAllBytes(path, [0x76, 0x65, 0x72, 0x73, 0x69, 0x6f, 0x6e, 0x20, 0x3d, 0x20, 0xff]);
        try
        {
            var ex = Assert.Throws<SdkException>(() => Config.LoadSafety(path));
            Assert.True(ex.Code is ErrorCode.Io or ErrorCode.Parse, ex.Message);
        }
        finally
        {
            File.Delete(path);
        }
    }
}
