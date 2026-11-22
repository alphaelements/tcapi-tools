using System.Diagnostics.CodeAnalysis;

namespace Tcapi.Sdk;

/// <summary>Outcome of an operation that does not throw for an SDK error: ok,
/// or the <see cref="SdkException"/> it failed with. Use it where a failure
/// is an expected branch (a device that is not there yet, a port that is busy)
/// and an exception would be control flow. Every method of
/// <see cref="Connection"/> is available this way through
/// <see cref="Connection.Try(Action{Connection})"/>.
/// Only <see cref="SdkException"/> is captured: a cancellation
/// (<see cref="OperationCanceledException"/>), a caller's bug
/// (<see cref="ArgumentException"/>) or any other exception still propagates.</summary>
public readonly struct SdkResult
{
    private SdkResult(SdkException? error)
    {
        Error = error;
    }

    /// <summary>True when the operation succeeded.</summary>
    public bool IsOk => Error is null;

    /// <summary>The error, or null when the operation succeeded.</summary>
    public SdkException? Error { get; }

    /// <summary>A success.</summary>
    public static SdkResult Ok() => new(null);

    /// <summary>A failure.</summary>
    public static SdkResult Fail(SdkException error)
    {
        ArgumentNullException.ThrowIfNull(error);
        return new SdkResult(error);
    }

    /// <summary>Throw the error if there is one (the original exception object).</summary>
    public void ThrowIfError()
    {
        if (Error is { } error)
        {
            throw error;
        }
    }

    /// <summary>Run <paramref name="operation"/> and capture an
    /// <see cref="SdkException"/> as a failure.</summary>
    public static SdkResult Capture(Action operation)
    {
        ArgumentNullException.ThrowIfNull(operation);
        try
        {
            operation();
            return Ok();
        }
        catch (SdkException error)
        {
            return Fail(error);
        }
    }

    /// <summary>Run <paramref name="operation"/> and capture its value, or the
    /// <see cref="SdkException"/> it threw.</summary>
    public static SdkResult<T> Capture<T>(Func<T> operation)
    {
        ArgumentNullException.ThrowIfNull(operation);
        try
        {
            return SdkResult<T>.Ok(operation());
        }
        catch (SdkException error)
        {
            return SdkResult<T>.Fail(error);
        }
    }

    /// <summary>The shape behind every <c>TryXxx(..., out value, out error)</c>
    /// method of the SDK: exactly one of <paramref name="value"/> and
    /// <paramref name="error"/> is set.</summary>
    internal static bool TryInvoke<T>(
        Func<T> operation,
        [NotNullWhen(true)] out T? value,
        [NotNullWhen(false)] out SdkException? error)
        where T : class
    {
        try
        {
            value = operation();
            error = null;
            return true;
        }
        catch (SdkException failure)
        {
            value = null;
            error = failure;
            return false;
        }
    }
}

/// <summary>A value, or the <see cref="SdkException"/> that stopped the
/// operation from producing it. See <see cref="SdkResult"/>.</summary>
public readonly struct SdkResult<T>
{
    private readonly T? _value;

    private SdkResult(T? value, SdkException? error)
    {
        _value = value;
        Error = error;
    }

    /// <summary>True when the operation produced a value.</summary>
    public bool IsOk => Error is null;

    /// <summary>The error, or null when the operation produced a value.</summary>
    public SdkException? Error { get; }

    /// <summary>The value; throws the error when the operation failed.</summary>
    public T Value => Error is { } error ? throw error : _value!;

    /// <summary>A success carrying <paramref name="value"/>.</summary>
    public static SdkResult<T> Ok(T value) => new(value, null);

    /// <summary>A failure.</summary>
    public static SdkResult<T> Fail(SdkException error)
    {
        ArgumentNullException.ThrowIfNull(error);
        return new SdkResult<T>(default, error);
    }

    /// <summary>Get the value without throwing.</summary>
    public bool TryGetValue([MaybeNullWhen(false)] out T value)
    {
        value = _value;
        return IsOk;
    }
}
