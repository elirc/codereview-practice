namespace Billing.Core.Data;

public enum SubscriptionStatus
{
    Trialing,
    Active,
    PastDue,
    Canceled,
}

public enum CancelReason
{
    Requested,
    DunningExhausted,
}

public enum InvoiceKind
{
    Cycle,
    Proration,
    Final,
    Manual,
}

public enum InvoiceStatus
{
    Draft,
    Open,
    Paid,
    Void,
    Uncollectible,
}

public enum InvoiceLineKind
{
    Flat,
    Seats,
    Usage,
    ProrationCredit,
    ProrationCharge,
    Manual,
}

public enum PaymentAttemptStatus
{
    Pending,
    Succeeded,
    Failed,
    Unknown,
}

public enum CreditNoteDisposition
{
    ReduceDue,
    Refund,
    CreditBalance,
}

public enum RefundStatus
{
    Pending,
    Succeeded,
    Failed,
}

public enum CreditTransactionKind
{
    CreditNote,
    AppliedToInvoice,
    VoidReversal,
    ManualAdjustment,
}

public enum CounterName
{
    Invoice,
    CreditNote,
}

public enum WebhookEndpointStatus
{
    Enabled,
    Disabled,
}

public enum WebhookDeliveryStatus
{
    Pending,
    Succeeded,
    Failed,
}

public enum ApiRole
{
    Service,
    Support,
    BillingOps,
    Admin,
}
