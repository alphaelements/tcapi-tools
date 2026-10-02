namespace Pochi.Sdk.Tests;

/// <summary>Scripted fake firmware generated from one golden test case: it
/// answers the requests of the case in order with the recorded response lines
/// and pushes the recorded events. Every response line it produces comes from
/// <c>protocol/golden</c> (docs/sdk-api-design.md section 8); there is no
/// hand-written device behaviour.
///
/// A request that differs from the recorded one (after
/// <see cref="GoldenCorpus.Normalize"/>, or byte for byte with
/// <see cref="Exact"/>) is recorded in <see cref="Mismatches"/> and gets no
/// response.</summary>
internal sealed class GoldenFw
{
    private readonly GoldenCase _case;
    private int _pos;
    private bool _handshake;

    public GoldenFw(GoldenCase goldenCase)
    {
        _case = goldenCase;
        Port.OnCommand = OnCommand;
    }

    public FakePort Port { get; } = new();

    /// <summary>Requests that did not match the script.</summary>
    public List<string> Mismatches { get; } = [];

    /// <summary>Compare requests byte for byte instead of semantically.</summary>
    public bool Exact { get; set; }

    /// <summary>The recorded request the device expects next, or null.</summary>
    public GoldenStep? NextRequest =>
        _case.Steps.Skip(_pos).FirstOrDefault(s => s.Kind == GoldenStepKind.Request);

    /// <summary>True once every request of the case has been answered or skipped.</summary>
    public bool Finished => NextRequest is null;

    /// <summary>Open a <see cref="Connection"/> over the fake device. The
    /// opening <c>version</c> handshake is answered with the golden response
    /// and is not part of the script.</summary>
    public Connection Connect()
    {
        _handshake = true;
        try
        {
            return Connection.FromPort(Port);
        }
        finally
        {
            _handshake = false;
        }
    }

    /// <summary>Push every recorded event that precedes the next request
    /// (skipping directives, which drive the simulated device). Returns the
    /// event payloads that were pushed.</summary>
    public List<string> PumpEvents()
    {
        var fed = new List<string>();
        while (_pos < _case.Steps.Count && _case.Steps[_pos].Kind != GoldenStepKind.Request)
        {
            var step = _case.Steps[_pos++];
            if (step.Kind == GoldenStepKind.Event)
            {
                Port.Feed("! " + step.Text);
                fed.Add(step.Text);
            }
        }

        return fed;
    }

    /// <summary>Consume the next recorded request without any command having
    /// been sent (the host refused it locally).</summary>
    public GoldenStep Skip()
    {
        PumpEvents();
        return _case.Steps[_pos++];
    }

    private void OnCommand(string line)
    {
        if (_handshake)
        {
            Port.Feed(GoldenCorpus.FirstResponse("version").ToArray());
            return;
        }

        PumpEvents();
        if (_pos >= _case.Steps.Count)
        {
            Mismatches.Add($"unexpected command \"{line}\" after the end of the script");
            return;
        }

        var step = _case.Steps[_pos++];
        var same = Exact
            ? line == step.Text
            : GoldenCorpus.Normalize(line) == GoldenCorpus.Normalize(step.Text);
        if (!same)
        {
            Mismatches.Add(
                $"{_case}: sent \"{line}\" but the golden request at line {step.Line} is "
                    + $"\"{step.Text}\"");
            return;
        }

        Port.Feed(step.Response.ToArray());
    }
}
