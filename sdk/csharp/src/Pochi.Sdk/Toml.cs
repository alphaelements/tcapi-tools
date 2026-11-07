using System.Globalization;
using System.Text;

namespace Pochi.Sdk;

// A small TOML 1.0 reader for the config files (docs/config-files.md).
//
// It is hand-written so the SDK stays free of reflection and of third-party
// parsers (NativeAOT friendly, Apache-2.0 only dependencies) and because the
// config files need the 1-based line of every key, table header and array
// element, which the value trees of the common libraries do not carry. It
// reads the full TOML 1.0 grammar except time-zone-aware date arithmetic:
// date and time values are recognised and kept as an opaque type.

/// <summary>Malformed TOML. <see cref="Line"/> is the 1-based line where the
/// parser found the problem.</summary>
internal sealed class TomlSyntaxException(int line, string message) : Exception(message)
{
    public int Line { get; } = line;
}

/// <summary>A parsed value. <see cref="Line"/> is the 1-based line of the key
/// that defines it (of the table header for <c>[table]</c> and
/// <c>[[array]]</c> entries; of the element for an array item).</summary>
internal abstract class TomlValue(int line)
{
    public int Line { get; } = line;
}

internal sealed class TomlString(int line, string value) : TomlValue(line)
{
    public string Value { get; } = value;
}

internal sealed class TomlInteger(int line, long value) : TomlValue(line)
{
    public long Value { get; } = value;
}

internal sealed class TomlBoolean(int line, bool value) : TomlValue(line)
{
    public bool Value { get; } = value;
}

internal sealed class TomlFloat(int line, double value) : TomlValue(line)
{
    public double Value { get; } = value;
}

/// <summary>A date, time or date-time value (not interpreted).</summary>
internal sealed class TomlDateTime(int line) : TomlValue(line);

internal sealed class TomlArray(int line, bool fromHeaders) : TomlValue(line)
{
    /// <summary>The array was built from <c>[[name]]</c> headers (it may grow by
    /// further headers); an array written as a value is fixed.</summary>
    public bool FromHeaders { get; } = fromHeaders;

    public List<TomlValue> Items { get; } = [];
}

/// <summary>A table; keys keep the order of the file.</summary>
internal sealed class TomlTable(int line) : TomlValue(line)
{
    private readonly Dictionary<string, TomlValue> _values = new(StringComparer.Ordinal);
    private readonly List<string> _keys = [];

    public IReadOnlyList<string> Keys => _keys;

    /// <summary>Defined by a <c>[table]</c> header.</summary>
    public bool Explicit { get; set; }

    /// <summary>Created by a dotted key (<c>a.b = 1</c> defines table <c>a</c>).</summary>
    public bool DottedDefined { get; set; }

    /// <summary>An inline table: complete, it cannot be extended.</summary>
    public bool Closed { get; set; }

    public TomlValue this[string key] => _values[key];

    public bool TryGetValue(string key, out TomlValue value)
    {
        if (_values.TryGetValue(key, out var found))
        {
            value = found;
            return true;
        }

        value = null!;
        return false;
    }

    public void Add(string key, TomlValue value)
    {
        _values.Add(key, value);
        _keys.Add(key);
    }
}

internal static class TomlParser
{
    /// <summary>Parse a TOML document. Throws <see cref="TomlSyntaxException"/>.</summary>
    public static TomlTable Parse(string src)
    {
        var text = src.Length > 0 && src[0] == '﻿' ? src[1..] : src;
        return new Reader(text).Document();
    }

    private sealed class Reader(string s)
    {
        private int _i;
        private int _line = 1;

        public TomlTable Document()
        {
            var root = new TomlTable(1) { Explicit = true };
            var current = root;
            while (true)
            {
                SkipBlank();
                if (_i >= s.Length)
                {
                    return root;
                }

                if (s[_i] == '[')
                {
                    current = Header(root);
                }
                else
                {
                    KeyValue(current);
                }

                EndOfStatement();
            }
        }

        // --- low level ---

        private TomlSyntaxException Error(string message) => new(_line, message);

        private bool At(char c) => _i < s.Length && s[_i] == c;

        private bool AtNewline() =>
            At('\n') || (At('\r') && _i + 1 < s.Length && s[_i + 1] == '\n');

        private void Newline()
        {
            _i += At('\r') ? 2 : 1;
            _line++;
        }

        private void SkipSpaces()
        {
            while (At(' ') || At('\t'))
            {
                _i++;
            }
        }

        private void SkipComment()
        {
            if (!At('#'))
            {
                return;
            }

            while (_i < s.Length && !AtNewline())
            {
                if (s[_i] == '\r')
                {
                    throw Error("a bare carriage return is not allowed");
                }

                _i++;
            }
        }

        /// <summary>Skip spaces, comments and line breaks.</summary>
        private void SkipBlank()
        {
            while (true)
            {
                SkipSpaces();
                SkipComment();
                if (AtNewline())
                {
                    Newline();
                    continue;
                }

                return;
            }
        }

        private void EndOfStatement()
        {
            SkipSpaces();
            SkipComment();
            if (_i >= s.Length)
            {
                return;
            }

            if (!AtNewline())
            {
                throw Error("expected the end of the line");
            }

            Newline();
        }

        // --- keys ---

        private static bool IsBareKeyChar(char c) =>
            c is >= 'A' and <= 'Z' or >= 'a' and <= 'z' or >= '0' and <= '9' or '_' or '-';

        private string Key()
        {
            if (At('"'))
            {
                return BasicString(multiline: false);
            }

            if (At('\''))
            {
                return LiteralString(multiline: false);
            }

            var start = _i;
            while (_i < s.Length && IsBareKeyChar(s[_i]))
            {
                _i++;
            }

            return _i > start ? s[start.._i] : throw Error("expected a key");
        }

        /// <summary>A dotted key, with optional spaces around the dots.</summary>
        private List<string> KeyPath()
        {
            var path = new List<string> { Key() };
            while (true)
            {
                SkipSpaces();
                if (!At('.'))
                {
                    return path;
                }

                _i++;
                SkipSpaces();
                path.Add(Key());
            }
        }

        // --- tables ---

        private TomlTable Header(TomlTable root)
        {
            var line = _line;
            var isArray = _i + 1 < s.Length && s[_i + 1] == '[';
            _i += isArray ? 2 : 1;
            SkipSpaces();
            var path = KeyPath();
            SkipSpaces();
            if (!At(']'))
            {
                throw Error("expected `]` to close the table header");
            }

            _i++;
            if (isArray)
            {
                if (!At(']'))
                {
                    throw Error("expected `]]` to close the array-of-tables header");
                }

                _i++;
            }

            var table = root;
            for (var k = 0; k < path.Count - 1; k++)
            {
                table = Descend(table, path[k], line);
            }

            var last = path[^1];
            if (isArray)
            {
                return AppendEntry(table, last, line);
            }

            if (!table.TryGetValue(last, out var existing))
            {
                var created = new TomlTable(line) { Explicit = true };
                table.Add(last, created);
                return created;
            }

            if (existing is TomlTable t && !t.Explicit && !t.DottedDefined && !t.Closed)
            {
                t.Explicit = true; // an implicit table, defined once now
                return t;
            }

            throw new TomlSyntaxException(line, $"table `{last}` is already defined");
        }

        /// <summary>Step into the table <paramref name="key"/> of a header path,
        /// creating it as an implicit table.</summary>
        private static TomlTable Descend(TomlTable table, string key, int line)
        {
            if (!table.TryGetValue(key, out var existing))
            {
                var created = new TomlTable(line);
                table.Add(key, created);
                return created;
            }

            return existing switch
            {
                TomlTable { Closed: false } t => t,
                TomlArray { FromHeaders: true } a when a.Items[^1] is TomlTable last => last,
                _ => throw new TomlSyntaxException(line, $"`{key}` is not a table that can be extended"),
            };
        }

        private static TomlTable AppendEntry(TomlTable table, string key, int line)
        {
            var entry = new TomlTable(line) { Explicit = true };
            if (!table.TryGetValue(key, out var existing))
            {
                var array = new TomlArray(line, fromHeaders: true);
                array.Items.Add(entry);
                table.Add(key, array);
                return entry;
            }

            if (existing is TomlArray { FromHeaders: true } list)
            {
                list.Items.Add(entry);
                return entry;
            }

            throw new TomlSyntaxException(line, $"`{key}` is not an array of tables");
        }

        // --- key = value ---

        private void KeyValue(TomlTable table)
        {
            var line = _line;
            var path = KeyPath();
            SkipSpaces();
            if (!At('='))
            {
                throw Error("expected `=` after the key");
            }

            _i++;
            SkipSpaces();
            var target = table;
            for (var k = 0; k < path.Count - 1; k++)
            {
                target = DescendDotted(target, path[k], line);
            }

            var value = Value(line);
            if (target.TryGetValue(path[^1], out _))
            {
                throw new TomlSyntaxException(line, $"duplicate key `{path[^1]}`");
            }

            target.Add(path[^1], value);
        }

        /// <summary>Step into the table <paramref name="key"/> named by a dotted key.
        /// Only tables created by dotted keys can be extended this way.</summary>
        private static TomlTable DescendDotted(TomlTable table, string key, int line)
        {
            if (!table.TryGetValue(key, out var existing))
            {
                var created = new TomlTable(line) { DottedDefined = true };
                table.Add(key, created);
                return created;
            }

            return existing is TomlTable { DottedDefined: true, Closed: false } t
                ? t
                : throw new TomlSyntaxException(line, $"key `{key}` is already defined");
        }

        // --- values ---

        /// <summary>Parse a value; <paramref name="line"/> is the line recorded in
        /// it (the line of its key, or of its place in an array).</summary>
        private TomlValue Value(int line)
        {
            if (_i >= s.Length || AtNewline() || At('#'))
            {
                throw Error("expected a value");
            }

            switch (s[_i])
            {
                case '"':
                    return new TomlString(line, BasicString(multiline: IsTriple('"')));
                case '\'':
                    return new TomlString(line, LiteralString(multiline: IsTriple('\'')));
                case '[':
                    return ArrayValue(line);
                case '{':
                    return InlineTable(line);
                default:
                    return Scalar(line);
            }
        }

        private bool IsTriple(char quote) =>
            _i + 2 < s.Length && s[_i + 1] == quote && s[_i + 2] == quote;

        private TomlArray ArrayValue(int line)
        {
            var array = new TomlArray(line, fromHeaders: false);
            _i++; // [
            while (true)
            {
                SkipBlank();
                if (At(']'))
                {
                    _i++;
                    return array;
                }

                array.Items.Add(Value(_line));
                SkipBlank();
                if (At(','))
                {
                    _i++;
                    continue;
                }

                if (At(']'))
                {
                    _i++;
                    return array;
                }

                throw Error("expected `,` or `]` in the array");
            }
        }

        private TomlTable InlineTable(int line)
        {
            var table = new TomlTable(line);
            _i++; // {
            SkipSpaces();
            if (At('}'))
            {
                _i++;
                table.Closed = true;
                return table;
            }

            while (true)
            {
                SkipSpaces();
                var path = KeyPath();
                SkipSpaces();
                if (!At('='))
                {
                    throw Error("expected `=` after the key");
                }

                _i++;
                SkipSpaces();
                var target = table;
                for (var k = 0; k < path.Count - 1; k++)
                {
                    target = DescendDotted(target, path[k], _line);
                }

                var value = Value(_line);
                if (target.TryGetValue(path[^1], out _))
                {
                    throw Error($"duplicate key `{path[^1]}`");
                }

                target.Add(path[^1], value);
                SkipSpaces();
                if (At(','))
                {
                    _i++;
                    continue;
                }

                if (At('}'))
                {
                    _i++;
                    table.Closed = true;
                    return table;
                }

                throw Error("expected `,` or `}` in the inline table");
            }
        }

        // --- strings ---

        private string LiteralString(bool multiline)
        {
            _i += multiline ? 3 : 1;
            var sb = new StringBuilder();
            if (multiline && AtNewline())
            {
                Newline();
            }

            while (true)
            {
                if (_i >= s.Length)
                {
                    throw Error("unterminated string");
                }

                var c = s[_i];
                if (c == '\'')
                {
                    if (!multiline)
                    {
                        _i++;
                        return sb.ToString();
                    }

                    if (CloseMultiline('\'', sb))
                    {
                        return sb.ToString();
                    }

                    continue;
                }

                if (AtNewline())
                {
                    if (!multiline)
                    {
                        throw Error("a string cannot contain a line break");
                    }

                    sb.Append('\n');
                    Newline();
                    continue;
                }

                CheckStringChar(c);
                sb.Append(c);
                _i++;
            }
        }

        private string BasicString(bool multiline)
        {
            _i += multiline ? 3 : 1;
            var sb = new StringBuilder();
            if (multiline && AtNewline())
            {
                Newline();
            }

            while (true)
            {
                if (_i >= s.Length)
                {
                    throw Error("unterminated string");
                }

                var c = s[_i];
                if (c == '"')
                {
                    if (!multiline)
                    {
                        _i++;
                        return sb.ToString();
                    }

                    if (CloseMultiline('"', sb))
                    {
                        return sb.ToString();
                    }

                    continue;
                }

                if (c == '\\')
                {
                    Escape(sb, multiline);
                    continue;
                }

                if (AtNewline())
                {
                    if (!multiline)
                    {
                        throw Error("a string cannot contain a line break");
                    }

                    sb.Append('\n');
                    Newline();
                    continue;
                }

                CheckStringChar(c);
                sb.Append(c);
                _i++;
            }
        }

        /// <summary>At a quote inside a multi-line string: three quotes close it
        /// (up to two more quotes before them belong to the text). Returns false
        /// after consuming a quote that is part of the text.</summary>
        private bool CloseMultiline(char quote, StringBuilder sb)
        {
            var run = 0;
            while (_i + run < s.Length && s[_i + run] == quote)
            {
                run++;
            }

            if (run < 3)
            {
                sb.Append(quote, run);
                _i += run;
                return false;
            }

            if (run > 5)
            {
                throw Error("too many quotes at the end of a multi-line string");
            }

            sb.Append(quote, run - 3);
            _i += run;
            return true;
        }

        private void CheckStringChar(char c)
        {
            if ((c < 0x20 && c != '\t') || c == 0x7f)
            {
                throw Error("a control character must be escaped in a string");
            }
        }

        private void Escape(StringBuilder sb, bool multiline)
        {
            _i++; // backslash
            if (_i >= s.Length)
            {
                throw Error("unterminated string");
            }

            var c = s[_i];
            if (multiline && (c is ' ' or '\t' or '\n' || (c == '\r' && AtNewlineAt(_i))))
            {
                LineEndingBackslash();
                return;
            }

            _i++;
            switch (c)
            {
                case 'b': sb.Append('\b'); break;
                case 't': sb.Append('\t'); break;
                case 'n': sb.Append('\n'); break;
                case 'f': sb.Append('\f'); break;
                case 'r': sb.Append('\r'); break;
                case '"': sb.Append('"'); break;
                case '\\': sb.Append('\\'); break;
                case 'u': sb.Append(UnicodeEscape(4)); break;
                case 'U': sb.Append(UnicodeEscape(8)); break;
                default: throw Error($"invalid escape sequence `\\{c}`");
            }
        }

        private bool AtNewlineAt(int i) => i + 1 < s.Length && s[i] == '\r' && s[i + 1] == '\n';

        /// <summary>A backslash at the end of a line in a multi-line basic string
        /// removes the line break and all whitespace up to the next character.</summary>
        private void LineEndingBackslash()
        {
            SkipSpaces();
            if (!AtNewline())
            {
                throw Error("invalid escape sequence `\\ `");
            }

            while (true)
            {
                SkipSpaces();
                if (AtNewline())
                {
                    Newline();
                    continue;
                }

                return;
            }
        }

        private string UnicodeEscape(int digits)
        {
            if (_i + digits > s.Length)
            {
                throw Error("incomplete unicode escape");
            }

            var hex = s.Substring(_i, digits);
            if (!uint.TryParse(
                    hex, NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture, out var code)
                || hex.Any(h => !char.IsAsciiHexDigit(h)))
            {
                throw Error($"invalid unicode escape `\\u{hex}`");
            }

            _i += digits;
            if (code is >= 0xD800 and <= 0xDFFF || code > 0x10FFFF)
            {
                throw Error($"`{hex}` is not a unicode scalar value");
            }

            return char.ConvertFromUtf32((int)code);
        }

        // --- scalars ---

        private static bool IsTokenChar(char c) =>
            c is not (' ' or '\t' or '\r' or '\n' or ',' or ']' or '}' or '#');

        private TomlValue Scalar(int line)
        {
            var start = _i;
            while (_i < s.Length && IsTokenChar(s[_i]))
            {
                _i++;
            }

            var token = s[start.._i];
            if (token.Length == 0)
            {
                throw Error("expected a value");
            }

            switch (token)
            {
                case "true":
                    return new TomlBoolean(line, true);
                case "false":
                    return new TomlBoolean(line, false);
                case "inf" or "+inf":
                    return new TomlFloat(line, double.PositiveInfinity);
                case "-inf":
                    return new TomlFloat(line, double.NegativeInfinity);
                case "nan" or "+nan" or "-nan":
                    return new TomlFloat(line, double.NaN);
            }

            if (LooksLikeDateTime(token))
            {
                // A date-time may contain one space between date and time; that
                // form is not supported and ends the value here.
                return IsDateTimeText(token)
                    ? new TomlDateTime(line)
                    : throw Error($"invalid date or time `{token}`");
            }

            if (token.Length > 1 && token[0] == '0' && token[1] is 'x' or 'o' or 'b')
            {
                return new TomlInteger(line, PrefixedInteger(token));
            }

            if (token.Any(c => c is '.' or 'e' or 'E'))
            {
                return new TomlFloat(line, Float(token));
            }

            return new TomlInteger(line, DecimalInteger(token));
        }

        private static bool LooksLikeDateTime(string t) =>
            (t.Length >= 5 && char.IsAsciiDigit(t[0]) && char.IsAsciiDigit(t[1]) && t[2] == ':')
            || (t.Length >= 10 && t[..4].All(char.IsAsciiDigit) && t[4] == '-');

        private static bool IsDateTimeText(string t) =>
            t.All(c => char.IsAsciiDigit(c) || c is '-' or ':' or '.' or 'T' or 't' or 'Z' or 'z' or '+');

        private long PrefixedInteger(string token)
        {
            var digits = token[2..];
            var radix = token[1] switch { 'x' => 16, 'o' => 8, _ => 2 };
            return ParseDigits(digits, radix, negative: false, token);
        }

        private long DecimalInteger(string token)
        {
            var negative = token[0] == '-';
            var digits = token[0] is '+' or '-' ? token[1..] : token;
            if (digits.Length > 1 && digits[0] == '0')
            {
                throw Error($"invalid integer `{token}`: leading zeros are not allowed");
            }

            return ParseDigits(digits, 10, negative, token);
        }

        /// <summary>Digits with single underscores between digits.</summary>
        private long ParseDigits(string digits, int radix, bool negative, string token)
        {
            if (digits.Length == 0 || digits[0] == '_' || digits[^1] == '_' || digits.Contains("__"))
            {
                throw Error($"invalid integer `{token}`");
            }

            ulong magnitude = 0;
            foreach (var c in digits)
            {
                if (c == '_')
                {
                    continue;
                }

                var d = DigitValue(c);
                if (d < 0 || d >= radix)
                {
                    throw Error($"invalid integer `{token}`");
                }

                if (magnitude > (ulong.MaxValue - (ulong)d) / (ulong)radix)
                {
                    throw Error($"integer `{token}` is out of range");
                }

                magnitude = (magnitude * (ulong)radix) + (ulong)d;
            }

            if (negative)
            {
                return magnitude <= (ulong)long.MaxValue + 1
                    ? unchecked(-(long)magnitude)
                    : throw Error($"integer `{token}` is out of range");
            }

            return magnitude <= long.MaxValue
                ? (long)magnitude
                : throw Error($"integer `{token}` is out of range");
        }

        private static int DigitValue(char c) => c switch
        {
            >= '0' and <= '9' => c - '0',
            >= 'a' and <= 'f' => c - 'a' + 10,
            >= 'A' and <= 'F' => c - 'A' + 10,
            _ => -1,
        };

        /// <summary><c>[+-]int [. digits] [e [+-] digits]</c> with at least a fraction or an exponent.</summary>
        private double Float(string token)
        {
            var body = token[0] is '+' or '-' ? token[1..] : token;
            var parts = body.Split('.', 2);
            var intPart = parts[0];
            var rest = parts.Length > 1 ? parts[1] : "";
            string? exponent = null;
            if (parts.Length == 1)
            {
                var e = intPart.IndexOfAny(['e', 'E']);
                if (e >= 0)
                {
                    exponent = intPart[(e + 1)..];
                    intPart = intPart[..e];
                }
            }
            else
            {
                var e = rest.IndexOfAny(['e', 'E']);
                if (e >= 0)
                {
                    exponent = rest[(e + 1)..];
                    rest = rest[..e];
                }
            }

            var ok = IsUnderscoredDigits(intPart)
                && (intPart.Length == 1 || intPart[0] != '0')
                && (parts.Length == 1 || IsUnderscoredDigits(rest))
                && (exponent is null || IsUnderscoredDigits(exponent.TrimStart('+', '-'))
                    && exponent.Length - exponent.TrimStart('+', '-').Length <= 1);
            if (!ok
                || !double.TryParse(
                    token.Replace("_", "", StringComparison.Ordinal),
                    NumberStyles.Float, CultureInfo.InvariantCulture, out var value))
            {
                throw Error($"invalid float `{token}`");
            }

            return value;
        }

        private static bool IsUnderscoredDigits(string t) =>
            t.Length > 0 && t[0] != '_' && t[^1] != '_' && !t.Contains("__", StringComparison.Ordinal)
            && t.All(c => char.IsAsciiDigit(c) || c == '_');
    }
}
