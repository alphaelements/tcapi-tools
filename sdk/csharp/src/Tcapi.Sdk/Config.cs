using System.Diagnostics.CodeAnalysis;
using System.Globalization;
using System.Text;

namespace Tcapi.Sdk;

/// <summary>A rejected configuration file. <see cref="SdkException.Code"/> is
/// <see cref="ErrorCode.Parse"/> and the message reads
/// <c>&lt;file&gt;:&lt;line&gt;: &lt;detail&gt;</c>.</summary>
public sealed class ConfigException : SdkException
{
    public ConfigException(string file, int line, string detail)
        : base(ErrorCode.Parse, $"{file}:{line}: {detail}")
    {
        File = file;
        Line = line;
        Detail = detail;
    }

    /// <summary>Name of the file as given to the parser (used in the message only).</summary>
    public string File { get; }

    /// <summary>1-based line of the offending element.</summary>
    public int Line { get; }

    /// <summary>The message of <c>docs/config-files.md</c> section 4, without the prefix.</summary>
    public string Detail { get; }
}

/// <summary>Readers for the host-side TOML configuration files (schema v2,
/// <c>docs/config-files.md</c>, R-TOML1/R-TOML2). This SDK reads
/// <c>safety.toml</c>.
///
/// There is no lenient mode: a <c>version</c> other than 2, an unknown key or a
/// contradictory setting is an error, and every error names the file and the
/// 1-based line of the offending element. Exactly one error is reported: the
/// first failing check, in the order the document defines (syntax,
/// <c>version</c>, unknown top-level keys, then <c>watchdog</c>, <c>usb</c>,
/// <c>exclusive</c>). The message texts are those of section 4; the shared
/// fixtures in <c>docs/fixtures</c> pin them down for every implementation.
/// The reader uses no reflection.</summary>
public static class Config
{
    private const long SchemaVersion = Pins.ProtoVersion;

    private static readonly string[] TopLevelKeys = ["version", "watchdog", "usb", "exclusive"];

    /// <summary>Parse the text of a <c>safety.toml</c> into the settings it
    /// declares: the watchdog timeout, <c>usbsafe</c> and one pin mask per
    /// exclusive group. <paramref name="file"/> only labels errors. Applying the
    /// result is <see cref="Connection.ApplySafety"/>.</summary>
    /// <exception cref="ConfigException">The text is not a valid <c>safety.toml</c>.</exception>
    public static SafetyConfig ParseSafety(string src, string file)
    {
        ArgumentNullException.ThrowIfNull(src);
        ArgumentNullException.ThrowIfNull(file);
        TomlTable table;
        try
        {
            table = TomlParser.Parse(src);
        }
        catch (TomlSyntaxException ex)
        {
            throw new ConfigException(file, ex.Line, "toml syntax: " + ex.Message);
        }

        CheckVersion(table, file);
        foreach (var key in SortedKeys(table))
        {
            if (!TopLevelKeys.Contains(key))
            {
                throw new ConfigException(file, table[key].Line, $"unknown key \"{key}\"");
            }
        }

        var watchdogMs = Watchdog(table, file);
        var usbSafe = Usb(table, file);
        return new SafetyConfig(watchdogMs, usbSafe, Groups(table, file));
    }

    /// <summary>Read and parse a <c>safety.toml</c>. Errors carry the path of the
    /// file; a file that cannot be read (or is not UTF-8) is
    /// <see cref="ErrorCode.Io"/>.</summary>
    public static SafetyConfig LoadSafety(string path)
    {
        ArgumentNullException.ThrowIfNull(path);
        string src;
        try
        {
            src = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: true)
                .GetString(File.ReadAllBytes(path));
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException
            or DecoderFallbackException or System.Security.SecurityException)
        {
            throw new SdkException(ErrorCode.Io, $"failed to read {path}: {ex.Message}", ex);
        }

        return ParseSafety(src, path);
    }

    /// <summary><see cref="ParseSafety"/> without throwing: false and the
    /// error (a <see cref="ConfigException"/> for a bad file) instead.</summary>
    public static bool TryParseSafety(
        string src,
        string file,
        [NotNullWhen(true)] out SafetyConfig? config,
        [NotNullWhen(false)] out SdkException? error) =>
        SdkResult.TryInvoke(() => ParseSafety(src, file), out config, out error);

    /// <summary><see cref="LoadSafety"/> without throwing: false and the error
    /// (<see cref="ErrorCode.Io"/> for an unreadable file) instead.</summary>
    public static bool TryLoadSafety(
        string path,
        [NotNullWhen(true)] out SafetyConfig? config,
        [NotNullWhen(false)] out SdkException? error) =>
        SdkResult.TryInvoke(() => LoadSafety(path), out config, out error);

    private static void CheckVersion(TomlTable table, string file)
    {
        if (!table.TryGetValue("version", out var version))
        {
            throw new ConfigException(file, 1, "missing key \"version\"");
        }

        if (version is not TomlInteger number)
        {
            throw new ConfigException(file, version.Line, "version must be an integer");
        }

        if (number.Value != SchemaVersion)
        {
            throw new ConfigException(
                file,
                version.Line,
                string.Create(
                    CultureInfo.InvariantCulture,
                    $"unsupported version: expected {SchemaVersion}, got {number.Value}"));
        }
    }

    /// <summary>The keys of <paramref name="table"/> in the order the checks visit
    /// them: sorted (ordinal), like the Rust reference and the other SDKs, so a
    /// file with several unknown keys reports the same one everywhere.</summary>
    private static IEnumerable<string> SortedKeys(TomlTable table) =>
        table.Keys.Order(StringComparer.Ordinal);

    /// <summary>The first key of <paramref name="table"/> (sorted) other than
    /// <paramref name="allowed"/> is an error named after the section.</summary>
    private static void CheckKeys(TomlTable table, string allowed, string section, string file)
    {
        foreach (var key in SortedKeys(table))
        {
            if (key != allowed)
            {
                throw new ConfigException(
                    file, table[key].Line, $"unknown key \"{key}\" in {section}");
            }
        }
    }

    private static uint Watchdog(TomlTable root, string file)
    {
        if (!root.TryGetValue("watchdog", out var value))
        {
            return 0;
        }

        if (value is not TomlTable table)
        {
            throw new ConfigException(file, value.Line, "watchdog must be a table");
        }

        CheckKeys(table, "timeout_ms", "watchdog", file);
        if (!table.TryGetValue("timeout_ms", out var timeout))
        {
            return 0;
        }

        if (timeout is not TomlInteger ms)
        {
            throw new ConfigException(file, timeout.Line, "watchdog.timeout_ms must be an integer");
        }

        return ms.Value == 0 || ms.Value is >= SafetyLimits.WdogMinMs and <= SafetyLimits.WdogMaxMs
            ? (uint)ms.Value
            : throw new ConfigException(
                file,
                timeout.Line,
                $"watchdog.timeout_ms must be 0 or between {SafetyLimits.WdogMinMs} "
                    + $"and {SafetyLimits.WdogMaxMs}");
    }

    private static bool Usb(TomlTable root, string file)
    {
        if (!root.TryGetValue("usb", out var value))
        {
            return false;
        }

        if (value is not TomlTable table)
        {
            throw new ConfigException(file, value.Line, "usb must be a table");
        }

        CheckKeys(table, "safe", "usb", file);
        if (!table.TryGetValue("safe", out var safe))
        {
            return false;
        }

        return safe is TomlBoolean flag
            ? flag.Value
            : throw new ConfigException(file, safe.Line, "usb.safe must be a boolean");
    }

    private static List<uint> Groups(TomlTable root, string file)
    {
        var groups = new List<uint>();
        if (!root.TryGetValue("exclusive", out var value))
        {
            return groups;
        }

        if (value is not TomlArray entries)
        {
            throw new ConfigException(file, value.Line, "exclusive must be an array of tables");
        }

        // Checked before any group, so 17 groups are always reported as too
        // many even if one of them is also faulty.
        if (entries.Items.Count > SafetyLimits.MaxExclusiveGroups)
        {
            throw new ConfigException(
                file,
                entries.Items[SafetyLimits.MaxExclusiveGroups].Line,
                $"too many exclusive groups: {entries.Items.Count} "
                    + $"(at most {SafetyLimits.MaxExclusiveGroups})");
        }

        for (var i = 0; i < entries.Items.Count; i++)
        {
            groups.Add(Group(entries.Items[i], i + 1, file));
        }

        return groups;
    }

    /// <summary>The pin mask of exclusive group <paramref name="n"/> (1-based).</summary>
    private static uint Group(TomlValue entry, int n, string file)
    {
        if (entry is not TomlTable group)
        {
            throw new ConfigException(file, entry.Line, $"exclusive group {n}: must be a table");
        }

        foreach (var key in SortedKeys(group))
        {
            if (key != "pins")
            {
                throw new ConfigException(
                    file, group[key].Line, $"unknown key \"{key}\" in exclusive group {n}");
            }
        }

        if (!group.TryGetValue("pins", out var pins))
        {
            throw new ConfigException(file, group.Line, $"exclusive group {n}: pins is required");
        }

        var notNames = $"exclusive group {n}: pins must be an array of pin names";
        if (pins is not TomlArray names)
        {
            throw new ConfigException(file, pins.Line, notNames);
        }

        uint mask = 0;
        foreach (var item in names.Items)
        {
            if (item is not TomlString name)
            {
                throw new ConfigException(file, pins.Line, notNames);
            }

            if (PinBit(name.Value) is not { } bit)
            {
                throw new ConfigException(
                    file, pins.Line, $"exclusive group {n}: invalid pin \"{name.Value}\" in pins");
            }

            if ((mask & (1U << bit)) != 0)
            {
                throw new ConfigException(
                    file, pins.Line, $"exclusive group {n}: duplicate pin \"{name.Value}\" in pins");
            }

            mask |= 1U << bit;
        }

        return uint.PopCount(mask) >= 2
            ? mask
            : throw new ConfigException(
                file, pins.Line, $"exclusive group {n}: a group needs at least 2 pins");
    }

    /// <summary>The bit of a canonical pin name <c>GP(0|[1-9][0-9]*)</c> that is a
    /// DIO pin (GP0-GP22, GP26, GP27); null for anything else (lower case,
    /// leading zeros, signs, spaces, non-ASCII digits, other pins).</summary>
    private static int? PinBit(string name)
    {
        if (!name.StartsWith("GP", StringComparison.Ordinal))
        {
            return null;
        }

        var digits = name.AsSpan(2);

        // At most two digits: the largest pin number is 27.
        if (digits.Length is 0 or > 2 || (digits.Length > 1 && digits[0] == '0'))
        {
            return null;
        }

        var bit = 0;
        foreach (var c in digits)
        {
            if (!char.IsAsciiDigit(c))
            {
                return null;
            }

            bit = (bit * 10) + (c - '0');
        }

        // The shift count is taken modulo 32, so the range check comes first.
        return bit < 32 && (Pins.ValidDioMask & (1U << bit)) != 0 ? bit : null;
    }
}
