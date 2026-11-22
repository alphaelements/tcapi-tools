using System.Globalization;

namespace Tcapi.Sdk.Tests;

// Loader for the v2 golden transcripts (protocol/golden/*.txt, format in
// protocol/golden/README.md). Every fake device in this test project is
// generated from these files (docs/sdk-api-design.md section 8).

internal enum GoldenStepKind
{
    /// <summary><c>&gt; request</c> with its response lines.</summary>
    Request,

    /// <summary><c>&lt; ! EVENT ...</c>.</summary>
    Event,

    /// <summary><c>~ directive</c>.</summary>
    Directive,
}

/// <summary>One step of a golden test case. For a request, <see cref="Text"/>
/// is the request line and <see cref="Response"/> the wire lines of the
/// response (header, then continuation lines with their two leading spaces).
/// For an event, <see cref="Text"/> is the payload after <c>! </c>. For a
/// directive, <see cref="Text"/> is the text after <c>~ </c>.</summary>
internal sealed record GoldenStep(
    GoldenStepKind Kind, string Text, IReadOnlyList<string> Response, int Line);

internal sealed record GoldenCase(
    string File, string Title, int FirstLine, IReadOnlyList<GoldenStep> Steps)
{
    /// <summary>The case sends raw bytes (<c>~ send_hex</c>), which a
    /// line-oriented host API cannot express.</summary>
    public bool HasSendHex => Steps.Any(s =>
        s.Kind == GoldenStepKind.Directive
        && s.Text.StartsWith("send_hex", StringComparison.Ordinal));

    /// <summary>The case sets exclusive groups (<c>excl set</c>), which makes the
    /// device check later maps against them.</summary>
    public bool ConfiguresExclusiveGroups => Steps.Any(s =>
        s.Kind == GoldenStepKind.Request
        && s.Text.StartsWith("excl set", StringComparison.OrdinalIgnoreCase));

    public override string ToString() => $"{File}.txt:{FirstLine} {Title}";
}

internal static class GoldenCorpus
{
    public static readonly string[] Files =
    [
        "version-info", "map", "io", "pattern", "timestamp", "sync", "reset", "errors",
        "boundary", "events", "safety",
    ];

    private static readonly Lazy<IReadOnlyList<GoldenCase>> AllCases = new(LoadAll);

    public static IReadOnlyList<GoldenCase> Cases => AllCases.Value;

    /// <summary>Directory <c>protocol/golden</c> of this repository.</summary>
    public static string Directory
    {
        get
        {
            for (var dir = new DirectoryInfo(AppContext.BaseDirectory);
                 dir is not null;
                 dir = dir.Parent)
            {
                var candidate = Path.Combine(dir.FullName, "protocol", "golden");
                if (File.Exists(Path.Combine(candidate, "version-info.txt")))
                {
                    return candidate;
                }
            }

            throw new DirectoryNotFoundException(
                "protocol/golden not found above " + AppContext.BaseDirectory);
        }
    }

    /// <summary>The single case of <paramref name="file"/> whose title is
    /// <paramref name="titlePart"/>, or else the single case whose title
    /// contains it.</summary>
    public static GoldenCase Case(string file, string titlePart)
    {
        var inFile = Cases.Where(c => c.File == file).ToList();
        var matches = inFile.Where(c => c.Title == titlePart).ToList();
        if (matches.Count == 0)
        {
            matches = inFile
                .Where(c => c.Title.Contains(titlePart, StringComparison.Ordinal))
                .ToList();
        }

        return matches.Count == 1
            ? matches[0]
            : throw new InvalidOperationException(
                $"{matches.Count} golden cases in {file}.txt match title \"{titlePart}\"");
    }

    /// <summary>Wire lines of the first response the golden files record for
    /// <paramref name="request"/> (compared after normalisation).</summary>
    public static IReadOnlyList<string> FirstResponse(string request)
    {
        var wanted = Normalize(request);
        foreach (var step in Cases.SelectMany(c => c.Steps))
        {
            if (step.Kind == GoldenStepKind.Request && Normalize(step.Text) == wanted)
            {
                return step.Response;
            }
        }

        throw new InvalidOperationException($"no golden response for \"{request}\"");
    }

    /// <summary>The first <c>OK</c> response line recorded for
    /// <paramref name="request"/> (first line only).</summary>
    public static string FirstOkLine(string request) =>
        FirstResponse(request).First(l => l.StartsWith("OK", StringComparison.Ordinal));

    /// <summary>Semantic form of a request line: lower case, single spaces,
    /// every number in decimal, the optional <c>v=2</c> of <c>map set</c> and the
    /// ignored repeat of <c>pattern run once</c> dropped, the keys of
    /// <c>map set</c> in alphabetical order. Two spellings the
    /// protocol treats as the same request normalise to the same text.</summary>
    public static string Normalize(string request)
    {
        var words = request.Split(new[] { ' ', '\t' }, StringSplitOptions.RemoveEmptyEntries)
            .Select(w => w.ToLowerInvariant())
            .ToList();
        if (words.Count >= 2 && words[0] == "map" && words[1] == "set")
        {
            // `v=2` is optional and the keys may come in any order.
            words.Remove("v=2");
            var keys = words.Skip(2).Order(StringComparer.Ordinal).ToList();
            words.RemoveRange(2, words.Count - 2);
            words.AddRange(keys);
        }

        if (words.Count > 3 && words[0] == "pattern" && words[1] == "run" && words[2] == "once")
        {
            words.RemoveRange(3, words.Count - 3);
        }

        return string.Join(' ', words.Select(NormalizeToken));
    }

    private static string NormalizeToken(string token)
    {
        var eq = token.IndexOf('=');
        if (eq > 0)
        {
            return token[..(eq + 1)] + NormalizeNumber(token[(eq + 1)..]);
        }

        var colon = token.IndexOf(':');
        if (colon > 0)
        {
            return NormalizeNumber(token[..colon]) + ":" + NormalizeNumber(token[(colon + 1)..]);
        }

        return NormalizeNumber(token);
    }

    private static string NormalizeNumber(string s)
    {
        if (s.Length > 2 && s.StartsWith("0x", StringComparison.Ordinal)
            && ulong.TryParse(s[2..], NumberStyles.AllowHexSpecifier,
                CultureInfo.InvariantCulture, out var hex))
        {
            return hex.ToString(CultureInfo.InvariantCulture);
        }

        if (s.Length > 0 && s.All(char.IsAsciiDigit)
            && ulong.TryParse(s, NumberStyles.None, CultureInfo.InvariantCulture, out var dec))
        {
            return dec.ToString(CultureInfo.InvariantCulture);
        }

        return s;
    }

    private static IReadOnlyList<GoldenCase> LoadAll() =>
        Files.SelectMany(f => Parse(f, File.ReadAllLines(Path.Combine(Directory, f + ".txt"))))
            .ToList();

    /// <summary>Split a golden file into test cases (a blank line ends a case;
    /// comment-only blocks such as the header are not cases).</summary>
    internal static IReadOnlyList<GoldenCase> Parse(string file, string[] lines)
    {
        var cases = new List<GoldenCase>();
        var steps = new List<GoldenStep>();
        var title = "";
        var first = 0;
        GoldenStep? open = null; // request or directive collecting response lines
        List<string>? openResponse = null;

        void CloseOpen()
        {
            if (open is not null)
            {
                steps.Add(open with { Response = openResponse! });
                open = null;
                openResponse = null;
            }
        }

        void Flush()
        {
            CloseOpen();
            if (steps.Count > 0)
            {
                cases.Add(new GoldenCase(file, title, first, steps.ToList()));
            }

            steps.Clear();
            title = "";
            first = 0;
        }

        for (var i = 0; i < lines.Length; i++)
        {
            var line = lines[i];
            var number = i + 1;
            if (line.Length == 0)
            {
                Flush();
                continue;
            }

            if (line.StartsWith("# ---", StringComparison.Ordinal) && title.Length == 0)
            {
                title = line.Trim('#', '-', ' ');
            }

            if (line.StartsWith('#'))
            {
                continue;
            }

            if (first == 0)
            {
                first = number;
            }

            if (line.StartsWith("> ", StringComparison.Ordinal))
            {
                CloseOpen();
                open = new GoldenStep(GoldenStepKind.Request, line[2..], [], number);
                openResponse = [];
            }
            else if (line.StartsWith("~ ", StringComparison.Ordinal))
            {
                CloseOpen();
                open = new GoldenStep(GoldenStepKind.Directive, line[2..], [], number);
                openResponse = [];
            }
            else if (line.StartsWith("< ! ", StringComparison.Ordinal))
            {
                CloseOpen();
                steps.Add(new GoldenStep(GoldenStepKind.Event, line[4..], [], number));
            }
            else if (line.StartsWith("< ", StringComparison.Ordinal) && openResponse is not null)
            {
                // Response header (OK / ERR) or continuation line: the wire
                // line is everything after "< ".
                openResponse.Add(line[2..]);
            }
            else
            {
                throw new FormatException($"{file}.txt:{number}: unexpected line: {line}");
            }
        }

        Flush();
        return cases;
    }
}
