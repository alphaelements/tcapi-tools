using Xunit;

namespace Pochi.Sdk.Tests;

// The TOML reader behind Config.ParseSafety: the subset of TOML 1.0 that
// the config files can contain, with the 1-based line of every key, table
// header and array element. Happy path, boundary and malformed input.

public class TomlTests
{
    private static TomlTable Parse(string src) => TomlParser.Parse(src);

    private static TomlSyntaxException Fails(string src)
    {
        var ex = Assert.Throws<TomlSyntaxException>(() => TomlParser.Parse(src));
        Assert.True(ex.Line >= 1, ex.Message);
        return ex;
    }

    [Fact]
    public void ScalarsAndTheirLines()
    {
        var t = Parse("# comment\na = 1\nb = \"x\"  # trailing\n\nc = true\nd = 'raw\\n'\ne = 1.5\nf = -7\n");
        Assert.Equal(1L, Assert.IsType<TomlInteger>(t["a"]).Value);
        Assert.Equal(2, t["a"].Line);
        Assert.Equal("x", Assert.IsType<TomlString>(t["b"]).Value);
        Assert.True(Assert.IsType<TomlBoolean>(t["c"]).Value);
        Assert.Equal(5, t["c"].Line);
        Assert.Equal("raw\\n", Assert.IsType<TomlString>(t["d"]).Value);
        Assert.IsType<TomlFloat>(t["e"]);
        Assert.Equal(-7L, Assert.IsType<TomlInteger>(t["f"]).Value);
    }

    [Theory]
    [InlineData("v = 0x1F", 31L)]
    [InlineData("v = 0o17", 15L)]
    [InlineData("v = 0b101", 5L)]
    [InlineData("v = 1_000", 1000L)]
    [InlineData("v = +5", 5L)]
    [InlineData("v = 0", 0L)]
    [InlineData("v = -0", 0L)]
    [InlineData("v = 9223372036854775807", long.MaxValue)]
    [InlineData("v = -9223372036854775808", long.MinValue)]
    public void IntegerForms(string src, long expected) =>
        Assert.Equal(expected, Assert.IsType<TomlInteger>(Parse(src)["v"]).Value);

    [Theory]
    [InlineData("v = 9223372036854775808")]
    [InlineData("v = 01")]
    [InlineData("v = 1__0")]
    [InlineData("v = _1")]
    [InlineData("v = 1_")]
    [InlineData("v = 0x")]
    [InlineData("v = 1.")]
    [InlineData("v = abc")]
    [InlineData("v = ")]
    [InlineData("v")]
    [InlineData("= 1")]
    public void MalformedValuesAreSyntaxErrors(string src) => Fails(src);

    [Fact]
    public void StringsAndEscapes()
    {
        var t = Parse("a = \"tab\\there \\u00e9 \\\"q\\\" \\\\\"\nb = \"\"\"\nline1\nline2\"\"\"\nc = '''x\ny'''\n");
        Assert.Equal("tab\there \u00e9 \"q\" \\", Assert.IsType<TomlString>(t["a"]).Value);
        Assert.Equal("line1\nline2", Assert.IsType<TomlString>(t["b"]).Value);
        Assert.Equal("x\ny", Assert.IsType<TomlString>(t["c"]).Value);
    }

    [Theory]
    [InlineData("a = \"open")]
    [InlineData("a = \"bad \\q escape\"")]
    [InlineData("a = \"new\nline\"")]
    [InlineData("a = \"\"\"never closed")]
    [InlineData("a = 'open")]
    [InlineData("a = \"\\u12\"")]
    [InlineData("a = \"\\ud800\"")]
    public void MalformedStringsAreSyntaxErrors(string src) => Fails(src);

    [Fact]
    public void ArraysMayContinueOverLinesAndKeepTheLineOfEachElement()
    {
        var t = Parse("a = [\n  1, # one\n  2,\n]\nb = []\nc = [[1], [2, 3]]\n");
        var a = Assert.IsType<TomlArray>(t["a"]);
        Assert.Equal(2, a.Items.Count);
        Assert.Equal(1, a.Line);
        Assert.Equal([2, 3], a.Items.Select(i => i.Line));
        Assert.Empty(Assert.IsType<TomlArray>(t["b"]).Items);
        Assert.Equal(2, Assert.IsType<TomlArray>(Assert.IsType<TomlArray>(t["c"]).Items[1]).Items.Count);
    }

    [Theory]
    [InlineData("a = [1 2]")]
    [InlineData("a = [1,,2]")]
    [InlineData("a = [,]")]
    [InlineData("a = [1")]
    [InlineData("a = [1]]")]
    public void MalformedArraysAreSyntaxErrors(string src) => Fails(src);

    [Fact]
    public void TablesAndTheirHeaderLines()
    {
        var t = Parse("v = 1\n\n[a]\nx = 1\n\n[b.c]\ny = 2\n");
        var a = Assert.IsType<TomlTable>(t["a"]);
        Assert.Equal(3, a.Line);
        Assert.Equal(4, a["x"].Line);
        var b = Assert.IsType<TomlTable>(t["b"]);
        var c = Assert.IsType<TomlTable>(b["c"]);
        Assert.Equal(6, c.Line);
        Assert.Equal(["v", "a", "b"], t.Keys);
    }

    [Fact]
    public void KeyOrderIsFileOrder()
    {
        var t = Parse("z = 1\na = 2\nm = 3\n");
        Assert.Equal(["z", "a", "m"], t.Keys);
    }

    [Fact]
    public void ArraysOfTablesCollectEntriesWithTheirHeaderLines()
    {
        var t = Parse("[[g]]\np = 1\n\n[[g]]\np = 2\n\n[[g]]\n");
        var g = Assert.IsType<TomlArray>(t["g"]);
        Assert.Equal([1, 4, 7], g.Items.Select(i => i.Line));
        Assert.All(g.Items, i => Assert.IsType<TomlTable>(i));
        Assert.Equal(2L, Assert.IsType<TomlInteger>(((TomlTable)g.Items[1])["p"]).Value);
        Assert.Empty(((TomlTable)g.Items[2]).Keys);
    }

    [Fact]
    public void InlineTablesAndDottedKeys()
    {
        var t = Parse("w = { a = 1, b = \"x\" }\nu.v = 5\nu.w = 6\nlist = [{ p = 1 }, { p = 2 }]\n");
        var w = Assert.IsType<TomlTable>(t["w"]);
        Assert.Equal(1, w["a"].Line);
        Assert.Equal(2, w.Keys.Count);
        var u = Assert.IsType<TomlTable>(t["u"]);
        Assert.Equal(2, u.Keys.Count);
        Assert.Equal(2, Assert.IsType<TomlArray>(t["list"]).Items.Count);
        Assert.Empty(Assert.IsType<TomlTable>(Parse("e = {}")["e"]).Keys);
    }

    [Theory]
    [InlineData("w = { a = 1,\n b = 2 }")] // inline tables are single-line
    [InlineData("w = { a = 1, }")] // no trailing comma
    [InlineData("w = { a = 1 b = 2 }")]
    [InlineData("w = { a = 1")]
    public void MalformedInlineTablesAreSyntaxErrors(string src) => Fails(src);

    [Fact]
    public void QuotedAndBareKeys()
    {
        var t = Parse("\"a b\" = 1\nbare-key_9 = 2\n'lit' = 3\n");
        Assert.Equal(["a b", "bare-key_9", "lit"], t.Keys);
    }

    [Theory]
    [InlineData("[a")] // the line of the malformed header
    [InlineData("[a]]")]
    [InlineData("[]")]
    [InlineData("[[a]")]
    [InlineData("[a b]")]
    [InlineData("a b = 1")]
    [InlineData("a = 1 b = 2")] // two keys on one line
    [InlineData("a = 1 # ok\nb")]
    [InlineData("a.=1")]
    [InlineData("\"unterminated = 1")]
    [InlineData("ключ = 1")] // bare keys are ASCII
    public void MalformedStructureIsASyntaxError(string src) => Fails(src);

    [Theory]
    [InlineData("a = 1\na = 2")] // duplicate key
    [InlineData("[a]\n[a]")] // table defined twice
    [InlineData("a = 1\n[a]")] // table over a value
    [InlineData("[a]\nb = 1\n[a.b]")] // sub table over a value
    [InlineData("w = {}\n[w]")] // an inline table is closed
    [InlineData("w = { a = 1 }\nw.b = 2")]
    [InlineData("a = []\n[[a]]")] // a static array cannot be extended
    [InlineData("[[a]]\n[a]")] // an array of tables is not a table
    [InlineData("x.y = 1\n[x]")] // dotted keys define the table
    public void RedefinitionsAreSyntaxErrors(string src) => Fails(src);

    [Fact]
    public void ImplicitTablesMayBeDefinedOnce()
    {
        var t = Parse("[a.b]\nx = 1\n[a]\ny = 2\n");
        var a = Assert.IsType<TomlTable>(t["a"]);
        Assert.Equal(2, a.Keys.Count);
        Assert.Equal(1, a.Line); // first mention
        Fails("[a.b]\n[a]\n[a]");
    }

    [Fact]
    public void ErrorsReportTheLineWhereTheyAreFound()
    {
        Assert.Equal(5, Fails("# 1\n# 2\n# 3\nversion = 2\n[watchdog\ntimeout_ms = 800\n").Line);
        Assert.Equal(2, Fails("version = 2\nunit = \n").Line);
        Assert.Equal(3, Fails("a = 1\nb = 2\nb = 3\n").Line);
        Assert.Equal(4, Fails("a = [\n1,\n2\nb = 1\n").Line);
    }

    [Fact]
    public void DateTimeValuesAreRecognisedAsTheirOwnType()
    {
        var t = Parse("d = 1979-05-27\nt = 07:32:00\ndt = 1979-05-27T07:32:00Z\n");
        Assert.All(["d", "t", "dt"], k => Assert.IsType<TomlDateTime>(t[k]));
    }

    [Fact]
    public void CrLfAndABomAreAccepted()
    {
        var t = Parse("\uFEFFa = 1\r\n[t]\r\nb = 2\r\n");
        Assert.Equal(1, t["a"].Line);
        Assert.Equal(3, ((TomlTable)t["t"])["b"].Line);
    }

    [Fact]
    public void EmptyInputIsAnEmptyTable() => Assert.Empty(Parse("").Keys);

    [Fact]
    public void ControlCharactersAreRejected() => Fails("a = \"x\u0001y\"");
}
