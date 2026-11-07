namespace Pochi.Sdk;

/// <summary>Options for opening a connection (<see cref="Connection.Open"/> and
/// the other ways to open one, <see cref="Discovery"/> probes included).</summary>
public sealed record ConnectionOptions
{
    /// <summary>The defaults: errors name the port.</summary>
    public static ConnectionOptions Default { get; } = new();

    /// <summary>Keep the serial port path (<c>/dev/ttyACM0</c>, <c>COM3</c>)
    /// out of the errors raised for the connection, for programs whose error
    /// text is shown to users or sent to a log that must not reveal the host's
    /// device layout. With it set, no message contains the path (nor, as a
    /// whole word, its final segment when that is at least three characters
    /// long, such as <c>ttyACM0</c>) and no inner exception is attached,
    /// because the operating system's own message names the path. Data stays
    /// as it is:
    /// <see cref="DeviceInfo.Port"/> and <see cref="ProbeFailure.Port"/> are
    /// values the caller needs in order to connect, not error text.</summary>
    public bool OmitPortPathFromErrors { get; init; }
}

/// <summary>Removes a serial port path from text that came from the operating
/// system.</summary>
internal static class PortPathScrubber
{
    /// <summary>Placeholder that replaces the path.</summary>
    internal const string Placeholder = "<port>";

    /// <summary>The shortest final segment that is scrubbed on its own. A
    /// shorter one (<c>1</c> of <c>/dev/pts/1</c>) would also match unrelated
    /// text such as byte counts.</summary>
    private const int MinSegmentLength = 3;

    /// <summary>Replace every occurrence of <paramref name="path"/> and, as a
    /// whole word, of its final segment (<c>ttyACM0</c> of
    /// <c>/dev/ttyACM0</c>) in <paramref name="text"/>. Returns
    /// <paramref name="text"/> unchanged unless <paramref name="omitPortPath"/>
    /// is set.</summary>
    internal static string Scrub(string text, string path, bool omitPortPath)
    {
        if (!omitPortPath || path.Length == 0)
        {
            return text;
        }

        var result = text.Replace(path, Placeholder, StringComparison.OrdinalIgnoreCase);
        var last = path.Split('/', '\\').LastOrDefault(segment => segment.Length != 0);
        return last is { Length: >= MinSegmentLength } && last != path
            ? ReplaceWord(result, last)
            : result;
    }

    private static string ReplaceWord(string text, string word)
    {
        var builder = new System.Text.StringBuilder(text.Length);
        var from = 0;
        while (true)
        {
            var at = text.IndexOf(word, from, StringComparison.OrdinalIgnoreCase);
            if (at < 0)
            {
                break;
            }

            var end = at + word.Length;
            var bounded = (at == 0 || !char.IsLetterOrDigit(text[at - 1]))
                && (end == text.Length || !char.IsLetterOrDigit(text[end]));
            builder.Append(text, from, at - from);
            builder.Append(bounded ? Placeholder : text.Substring(at, word.Length));
            from = end;
        }

        return builder.Append(text, from, text.Length - from).ToString();
    }
}
