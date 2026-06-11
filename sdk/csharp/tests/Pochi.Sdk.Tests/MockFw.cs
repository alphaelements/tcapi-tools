using System.Buffers.Binary;
using System.Globalization;

namespace Pochi.Sdk.Tests;

/// <summary>Stateful mock firmware implementing the FW Phase 9.6 command
/// set. Equivalent implementations exist in all SDK languages (Rust
/// <c>pty_e2e.rs</c>, TS, Python <c>fake_port.py</c>) — keep them in sync
/// when the protocol changes.</summary>
internal sealed class MockFw
{
    public uint Outputs;
    public uint Inputs = 0x05;
    public string Map = "v=1 out=0:12 in=12:11 pull=up flags=0x01";
    public int PatternLoaded;
    public string PatternState = "idle";
    public bool TsArmed;
    public List<string> TsEvents =
        ["  0x00000005 c=1000 p=7 s=1", "  0x0000000A c=2000 p=12 s=0"];
    public bool TsOverflow;
    public bool SyncClocking;
    public bool OldFirmware;

    public List<string> Handle(string cmd)
    {
        var parts = cmd.Trim().ToLowerInvariant()
            .Split(' ', StringSplitOptions.RemoveEmptyEntries);
        var key = string.Join(' ', parts);
        switch (key)
        {
            case "version":
                return ["OK v0.1.0 proto=1"];
            case "caps":
                {
                    var tsRes = OldFirmware ? 1000 : 40;
                    return [$"OK dio=23 out=12 in=11 ts_res={tsRes}ns pattern=256 ring=256 "
                    + "feat=0x00000001"];
                }

            case "info":
                return ["OK uid=AABBCCDD11223344 devnum=42"];
            case "read":
                return [$"OK 0x{Inputs:X6}"];
            case "state":
                return [$"OK in=0x{Inputs:X6} out=0x{Outputs:X6} flags=0x00"];
            case "map get":
                return [$"OK {Map}"];
            case "map save":
                return ["OK"];
            case "map default":
                Map = "v=1 out=0:0 in=0:23 pull=down flags=0x01";
                return ["OK"];
            case "pattern stop":
                if (PatternLoaded > 0)
                {
                    PatternState = "loaded";
                }

                return ["OK"];
            case "pattern status":
                return [$"OK state={PatternState} step=0 loops=0"];
            case "ts disarm":
                TsArmed = false;
                return ["OK"];
            case "sync arm" or "sync master" or "sync disarm":
                return ["OK"];
            case "sync start":
                SyncClocking = true;
                return ["OK"];
            case "sync stop":
                SyncClocking = false;
                return ["OK"];
            case "sync count":
                // `OK count=N` with NO data lines (unlike `ts get`).
                return SyncClocking ? ["OK count=1000000"] : ["ERR SYNC_STATE"];
        }

        if (parts.Length > 0 && parts[0] == "devnum")
        {
            return ["OK"];
        }

        if (parts.Length > 0 && parts[0] == "write")
        {
            if (parts.Length < 3
                || !TryParseAuto(parts[1], out var v)
                || !TryParseAuto(parts[2], out var m))
            {
                return ["ERR BAD_PARAM"];
            }

            Outputs = (Outputs & ~m) | (v & m);
            return ["OK"];
        }

        if (parts.Length > 0 && parts[0] == "subscribe")
        {
            return ["OK"];
        }

        if (parts.Length >= 2 && parts[0] == "map" && parts[1] == "set")
        {
            var hex = parts.Length > 2 ? parts[2] : "";
            if (hex.Length != 48)
            {
                return ["ERR BAD_PARAM"];
            }

            var data = Convert.FromHexString(hex);
            if (data[2] != 0 && data[4] != 0 && data[3] < data[1] + data[2])
            {
                return ["ERR BAD_MAP"];
            }

            var pull = data[5] switch { 0 => "none", 1 => "up", _ => "down" };
            Map = $"v={data[0]} out={data[1]}:{data[2]} in={data[3]}:{data[4]} "
                + $"pull={pull} flags=0x{data[6]:x2}";
            return ["OK"];
        }

        if (parts.Length >= 2 && parts[0] == "pattern" && parts[1] == "load")
        {
            byte[] data;
            try
            {
                data = Convert.FromHexString(parts.Length > 2 ? parts[2] : "");
            }
            catch (FormatException)
            {
                return ["ERR BAD_PARAM"];
            }

            if (data.Length < 10)
            {
                return ["ERR BAD_PARAM"];
            }

            var count = BinaryPrimitives.ReadUInt16LittleEndian(data.AsSpan(0, 2));
            if (data.Length != 2 + count * 8)
            {
                return ["ERR BAD_PARAM"];
            }

            PatternLoaded = count;
            PatternState = "loaded";
            return [$"OK accepted={count}"];
        }

        if (parts.Length >= 2 && parts[0] == "pattern" && parts[1] == "run")
        {
            if (PatternLoaded == 0)
            {
                return ["ERR BAD_PARAM"];
            }

            if (parts.Length >= 4 && parts[2] == "loop" && parts[3] == "0")
            {
                return ["ERR BAD_PARAM"];
            }

            if (PatternState == "running")
            {
                return ["ERR BUSY"];
            }

            PatternState = "running";
            return ["OK"];
        }

        if (parts.Length >= 2 && parts[0] == "ts" && parts[1] == "arm")
        {
            if (TsArmed)
            {
                return ["ERR BUSY"];
            }

            TsArmed = true;
            return ["OK"];
        }

        if (parts.Length >= 2 && parts[0] == "ts" && parts[1] == "get")
        {
            if (!TsArmed)
            {
                return ["ERR NOT_ARMED"];
            }

            if (OldFirmware)
            {
                return ["OK count=1", "  0x00000005 t=1234567890"];
            }

            var maxEvents = parts.Length > 2
                ? int.Parse(parts[2], CultureInfo.InvariantCulture)
                : 0;
            var events = TsEvents.Take(maxEvents).ToList();
            var overflowFlag = TsOverflow ? 1 : 0;
            return [$"OK count={events.Count} overflow={overflowFlag}", .. events];
        }

        return ["ERR UNKNOWN_CMD"];
    }

    private static bool TryParseAuto(string s, out uint value)
    {
        if (s.StartsWith("0x", StringComparison.Ordinal))
        {
            return uint.TryParse(s[2..], NumberStyles.HexNumber,
                CultureInfo.InvariantCulture, out value);
        }

        return uint.TryParse(s, NumberStyles.None, CultureInfo.InvariantCulture, out value);
    }
}
