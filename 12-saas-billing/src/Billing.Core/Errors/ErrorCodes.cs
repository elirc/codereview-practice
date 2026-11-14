namespace Billing.Core.Errors;

/// <summary>Stable error codes used in the error envelope.</summary>
public static class ErrorCodes
{
    public const string ValidationFailed = "validation_failed";
    public const string Unauthenticated = "unauthenticated";
    public const string Forbidden = "forbidden";
    public const string NotFound = "not_found";
    public const string InvalidState = "invalid_state";
    public const string InternalError = "internal_error";
    public const string AlreadyExists = "already_exists";
    public const string PlanIncompatible = "plan_incompatible";
    public const string AlreadySubscribed = "already_subscribed";
    public const string RenewalInProgress = "renewal_in_progress";
    public const string InvoiceNotFinalizable = "invoice_not_finalizable";
    public const string PaymentInProgress = "payment_in_progress";
    public const string ExceedsCreditable = "exceeds_creditable";
    public const string ExceedsRemaining = "exceeds_remaining";
    public const string ExceedsRefundable = "exceeds_refundable";
    public const string InsufficientCredit = "insufficient_credit";
    public const string TaxRateOverlap = "tax_rate_overlap";
    public const string IdempotencyKeyRequired = "idempotency_key_required";
    public const string IdempotencyKeyReused = "idempotency_key_reused";
    public const string PayloadTooLarge = "payload_too_large";
    public const string UnsupportedMediaType = "unsupported_media_type";
}
