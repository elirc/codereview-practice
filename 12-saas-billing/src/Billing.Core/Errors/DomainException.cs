namespace Billing.Core.Errors;

/// <summary>A failure that maps to a specific HTTP status and stable error code.</summary>
public sealed class DomainException : Exception
{
    public DomainException(int status, string code, string message, object? details = null)
        : base(message)
    {
        Status = status;
        Code = code;
        Details = details;
    }

    public int Status { get; }

    public string Code { get; }

    public object? Details { get; }

    public static DomainException NotFound(string resource) =>
        new(404, ErrorCodes.NotFound, $"{resource} was not found.");

    public static DomainException Conflict(string code, string message, object? details = null) =>
        new(409, code, message, details);

    public static DomainException InvalidState(string message) =>
        new(409, ErrorCodes.InvalidState, message);

    public static DomainException Unprocessable(string code, string message, object? details = null) =>
        new(422, code, message, details);

    public static DomainException BadRequest(string code, string message) =>
        new(400, code, message);

    public static DomainException Validation(IReadOnlyList<FieldError> fields) =>
        new(400, ErrorCodes.ValidationFailed, "The request is invalid.", new ValidationDetails(fields));

    public static DomainException Validation(string path, string message) =>
        Validation([new FieldError(path, message)]);

    public static DomainException Unauthenticated() =>
        new(401, ErrorCodes.Unauthenticated, "A valid API key is required.");

    public static DomainException Forbidden() =>
        new(403, ErrorCodes.Forbidden, "This API key is not allowed to perform the action.");
}

/// <summary>One invalid field in a request.</summary>
public sealed record FieldError(string Path, string Message);

/// <summary>The details object of a validation failure.</summary>
public sealed record ValidationDetails(IReadOnlyList<FieldError> Fields);
