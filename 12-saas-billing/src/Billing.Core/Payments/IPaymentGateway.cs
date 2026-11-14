namespace Billing.Core.Payments;

/// <summary>Result of a gateway charge or lookup.</summary>
public abstract record GatewayResult
{
    /// <summary>The charge went through.</summary>
    public sealed record Succeeded(string ChargeId) : GatewayResult;

    /// <summary>The charge was refused with the given code.</summary>
    public sealed record Declined(string Code) : GatewayResult;

    /// <summary>The gateway has no charge for the idempotency key.</summary>
    public sealed record NotFound : GatewayResult;
}

/// <summary>Charges and refunds through the payment provider.</summary>
public interface IPaymentGateway
{
    /// <summary>Charges the payment method; returns <see cref="GatewayResult.Succeeded"/> or <see cref="GatewayResult.Declined"/>, or throws <see cref="GatewayTimeoutException"/>.</summary>
    Task<GatewayResult> ChargeAsync(string token, long amountMinor, string currency, string idempotencyKey, CancellationToken ct);

    /// <summary>Returns the outcome of an earlier charge with the idempotency key, or <see cref="GatewayResult.NotFound"/>.</summary>
    Task<GatewayResult> LookupAsync(string idempotencyKey, CancellationToken ct);

    /// <summary>Refunds part or all of a charge and returns the refund id; throws <see cref="PaymentGatewayException"/> on failure.</summary>
    Task<string> RefundAsync(string chargeId, long amountMinor, string idempotencyKey, CancellationToken ct);
}

/// <summary>The gateway could not complete a request.</summary>
public class PaymentGatewayException(string message) : Exception(message);

/// <summary>The gateway did not answer in time; the request may or may not have been processed.</summary>
public sealed class GatewayTimeoutException(string message) : PaymentGatewayException(message);
