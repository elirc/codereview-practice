using System.Text;
using System.Text.Json;
using Billing.Core.Data;
using Billing.Core.Errors;
using Billing.Core.Json;
using Billing.Core.Services;
using Microsoft.EntityFrameworkCore;

namespace Billing.Api.Infrastructure;

/// <summary>Runs an operation under the request's <c>Idempotency-Key</c> and replays stored responses.</summary>
public sealed class IdempotentExecutor(BillingDbContext db, TimeProvider clock)
{
    public const string HeaderName = "Idempotency-Key";
    private const string OperationSavepoint = "idempotent_operation";

    /// <summary>
    /// Returns the stored response for a key already used with the same request, or runs the operation in one
    /// transaction with the key's record and stores its success or business-rule response.
    /// </summary>
    public Task<IResult> ExecuteAsync<T>(
        HttpContext http,
        object request,
        int successStatus,
        Func<Task<T>> operation,
        CancellationToken ct) =>
        RunAsync(http, ReadKey(http), request, successStatus, operation, ct);

    /// <summary>
    /// Runs the operation as <see cref="ExecuteAsync{T}"/> does when the request carries an <c>Idempotency-Key</c>,
    /// and runs it directly, answering with <paramref name="successStatus"/>, when it does not.
    /// </summary>
    public async Task<IResult> ExecuteOptionalAsync<T>(
        HttpContext http,
        object request,
        int successStatus,
        Func<Task<T>> operation,
        CancellationToken ct)
    {
        if (!HasKey(http))
        {
            return Results.Json(await operation(), BillingJson.Options, statusCode: successStatus);
        }

        return await RunAsync(http, ReadKey(http), request, successStatus, operation, ct);
    }

    /// <summary>Returns whether the request carries an <c>Idempotency-Key</c> header.</summary>
    public static bool HasKey(HttpContext http) => http.Request.Headers.ContainsKey(HeaderName);

    private async Task<IResult> RunAsync<T>(
        HttpContext http,
        string key,
        object request,
        int successStatus,
        Func<Task<T>> operation,
        CancellationToken ct)
    {
        var caller = http.GetCaller();
        var requestHash = Hash(http, request);

        for (var attempt = 1; ; attempt++)
        {
            await using var transaction = await db.Database.BeginTransactionAsync(ct);
            var existing = await FindAsync(key, ct);
            if (existing is not null)
            {
                return Replay(existing, requestHash);
            }

            db.IdempotencyRecords.Add(new IdempotencyRecord
            {
                KeyId = caller.KeyId,
                Key = key,
                RequestHash = requestHash,
                ResponseStatus = 0,
                ResponseBody = string.Empty,
                CreatedAt = clock.GetUtcNow(),
            });

            try
            {
                await db.SaveChangesAsync(ct);
            }
            catch (DbUpdateException ex) when (ex.IsUniqueViolation("pk_idempotency_records") && attempt == 1)
            {
                await transaction.RollbackAsync(ct);
                db.ChangeTracker.Clear();
                continue;
            }

            await transaction.CreateSavepointAsync(OperationSavepoint, ct);

            int status;
            string body;
            try
            {
                var result = await operation();
                status = successStatus;
                body = JsonSerializer.Serialize(result, BillingJson.Options);
            }
            catch (DomainException ex) when (ex.Status is StatusCodes.Status409Conflict or StatusCodes.Status422UnprocessableEntity)
            {
                await transaction.RollbackToSavepointAsync(OperationSavepoint, ct);
                db.ChangeTracker.Clear();
                status = ex.Status;
                body = ErrorEnvelope.Serialize(ex.Code, ex.Message, ex.Details, http.TraceIdentifier);
            }

            await StoreResponseAsync(key, status, body, ct);
            await transaction.CommitAsync(ct);
            return Results.Content(body, "application/json", Encoding.UTF8, status);
        }
    }

    private Task<IdempotencyRecord?> FindAsync(string key, CancellationToken ct) =>
        db.IdempotencyRecords.AsNoTracking().FirstOrDefaultAsync(r => r.Key == key, ct);

    private Task<int> StoreResponseAsync(string key, int status, string body, CancellationToken ct) =>
        db.IdempotencyRecords
            .Where(r => r.Key == key)
            .ExecuteUpdateAsync(s => s.SetProperty(r => r.ResponseStatus, status).SetProperty(r => r.ResponseBody, body), ct);

    private static string ReadKey(HttpContext http)
    {
        var key = http.Request.Headers[HeaderName].ToString();
        if (key.Length == 0)
        {
            throw DomainException.BadRequest(ErrorCodes.IdempotencyKeyRequired, "An Idempotency-Key header is required.");
        }

        if (key.Length is < 8 or > 128)
        {
            throw DomainException.Validation(HeaderName, "Must be between 8 and 128 characters.");
        }

        return key;
    }

    private static string Hash(HttpContext http, object request)
    {
        var canonical = JsonSerializer.Serialize(request, request.GetType(), BillingJson.Options);
        return Hashing.Sha256Hex($"{http.Request.Method}\n{http.Request.Path.Value}\n{canonical}");
    }

    private static IResult Replay(IdempotencyRecord record, string requestHash)
    {
        if (record.RequestHash != requestHash)
        {
            throw DomainException.Unprocessable(ErrorCodes.IdempotencyKeyReused, "This Idempotency-Key was used with a different request.");
        }

        return Results.Content(record.ResponseBody, "application/json", Encoding.UTF8, record.ResponseStatus);
    }
}
