namespace Pochi.Sdk;

/// <summary>Watchdog heartbeat helper (protocol-reference.md section 4,
/// "Safety"). The device trips its watchdog when it sees no <c>OK</c> answer
/// for the timeout given to <c>wdog</c>; whoever enables the watchdog must keep
/// the device busy. <see cref="Connection.StartHeartbeat"/> starts a dedicated
/// thread that sends <c>ping &lt;n&gt;</c> periodically. The rules, shared by every
/// SDK (docs/sdk-api-design.md, "Heartbeat"):
/// <list type="bullet">
/// <item><b>Period</b> = timeout / 4, at most 1 s (<see cref="PeriodFor"/>); the first
/// ping is sent one period after the start.</item>
/// <item><b>Serialised.</b> A heartbeat ping is a normal command exchange: it takes the
/// connection for the whole request and response, so it is never written between
/// another command and its response, nor inside a counted response. A long command
/// of the caller (for example <c>map save</c>) delays the ping.</item>
/// <item><b>A failure is notified once and not retried.</b> The first failed ping
/// (timeout, <c>ERR</c>, wrong <c>pong</c>, disconnect) ends the heartbeat and is
/// delivered through <see cref="Failed"/>, <see cref="Failure"/> and
/// <see cref="WaitFailure"/>. It sends no further ping and does not repair the
/// connection; the device trips its watchdog, which is the safe outcome.</item>
/// <item><b>Closing changes nothing.</b> Stopping or disposing the heartbeat,
/// closing the connection and dropping it send no command and change no output.
/// A closed or dropped connection ends the heartbeat silently (not a
/// failure).</item>
/// </list></summary>
public sealed class Heartbeat : IDisposable
{
    /// <summary>Longest heartbeat period.</summary>
    private static readonly TimeSpan MaxPeriod = TimeSpan.FromSeconds(1);

    private readonly ManualResetEventSlim _stop = new(false);
    private readonly ManualResetEventSlim _ended = new(false);
    private readonly Thread _thread;
    private volatile SdkException? _failure;

    private Heartbeat(Connection connection, TimeSpan period)
    {
        Period = period;
        var weak = new WeakReference<Connection>(connection);
        _thread = new Thread(() => Run(weak)) { IsBackground = true, Name = "pochi-heartbeat" };
    }

    /// <summary>The interval between pings.</summary>
    public TimeSpan Period { get; }

    /// <summary>True while the thread is sending pings (false after a failure,
    /// after the connection was closed or dropped, and after
    /// <see cref="Stop"/>).</summary>
    public bool IsRunning => !_ended.IsSet;

    /// <summary>The failure that ended the heartbeat, or null.</summary>
    public SdkException? Failure => _failure;

    /// <summary>Raised once, on the heartbeat thread, with the failure that ended
    /// the heartbeat. A handler added after the failure is not called: read
    /// <see cref="Failure"/>. A handler must be quick, must not call back into the
    /// connection and its own exceptions are logged
    /// (<see cref="Connection.ErrorLog"/>), not rethrown.</summary>
    public event Action<SdkException>? Failed;

    /// <summary>The heartbeat period for a watchdog timeout: timeout / 4, at most
    /// 1 s. <paramref name="timeoutMs"/> must be a value <c>wdog</c> accepts for
    /// an enabled watchdog (100-10000); 0 (disabled) needs no heartbeat and is
    /// refused with <see cref="ErrorCode.InvalidArgument"/>.</summary>
    public static TimeSpan PeriodFor(uint timeoutMs)
    {
        if (timeoutMs is < SafetyLimits.WdogMinMs or > SafetyLimits.WdogMaxMs)
        {
            throw new SdkException(
                ErrorCode.InvalidArgument,
                $"heartbeat needs an enabled watchdog timeout between {SafetyLimits.WdogMinMs} "
                    + $"and {SafetyLimits.WdogMaxMs} ms, got {timeoutMs}");
        }

        var period = TimeSpan.FromMilliseconds(timeoutMs / 4);
        return period < MaxPeriod ? period : MaxPeriod;
    }

    internal static Heartbeat Start(Connection connection, uint timeoutMs)
    {
        var heartbeat = new Heartbeat(connection, PeriodFor(timeoutMs));
        heartbeat._thread.Start();
        return heartbeat;
    }

    /// <summary>Wait up to <paramref name="timeout"/> for the heartbeat to end and
    /// return its failure; null when it is still running, or ended without a
    /// failure (stopped, or the connection was closed). Repeatable: it returns the
    /// same failure every time.</summary>
    public SdkException? WaitFailure(TimeSpan timeout) => _ended.Wait(timeout) ? _failure : null;

    /// <summary>Stop sending pings and wait for the thread to end. Sends nothing
    /// to the device. An exchange in progress is finished first (at most one
    /// command timeout). Idempotent.</summary>
    public void Stop()
    {
        _stop.Set();
        if (Thread.CurrentThread != _thread)
        {
            _thread.Join();
        }
    }

    public void Dispose() => Stop();

    /// <summary>Wait one period, ping, repeat. Ends when stopped, when the
    /// connection is closed or gone, or after reporting the first failure.</summary>
    private void Run(WeakReference<Connection> weak)
    {
        try
        {
            uint value = 0;
            while (!_stop.Wait(Period))
            {
                // The connection was closed or dropped: nothing to keep alive,
                // not a failure.
                if (!weak.TryGetTarget(out var connection) || connection.IsClosed)
                {
                    return;
                }

                try
                {
                    connection.Ping(value);
                }
                catch (Exception ex)
                {
                    if (connection.IsClosed)
                    {
                        return;
                    }

                    Fail(connection, ex as SdkException
                        ?? new SdkException(
                            ErrorCode.Io, $"heartbeat ping failed: {ex.Message}", ex));
                    return;
                }

                value = unchecked(value + 1);
            }
        }
        finally
        {
            _ended.Set();
        }
    }

    private void Fail(Connection connection, SdkException failure)
    {
        _failure = failure;
        try
        {
            Failed?.Invoke(failure);
        }
        catch (Exception ex)
        {
            connection.LogError($"heartbeat failure handler threw: {ex}");
        }
    }
}
