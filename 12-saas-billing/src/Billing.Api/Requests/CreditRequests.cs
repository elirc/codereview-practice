using Billing.Api.Validation;
using Billing.Core.Data;

namespace Billing.Api.Requests;

public sealed record CreditNoteLineRequest(Guid? InvoiceLineId, long? AmountMinor);

public sealed record CreateCreditNoteRequest(IReadOnlyList<CreditNoteLineRequest>? Lines, string? Reason, CreditNoteDisposition? Disposition);

public sealed record CreditAdjustmentRequest(long? AmountMinor, string? Reason);

internal sealed class CreateCreditNoteValidator : IValidator<CreateCreditNoteRequest>
{
    public void Validate(CreateCreditNoteRequest value, ValidationErrors errors)
    {
        errors.Text(value.Reason, "reason", 1, 200);
        errors.Required(value.Disposition, "disposition");
        if (value.Lines is null || value.Lines.Count is 0 or > ManualLineRules.MaxLines)
        {
            errors.Add("lines", $"Between 1 and {ManualLineRules.MaxLines} lines are required.");
            return;
        }

        var seen = new HashSet<Guid>();
        for (var i = 0; i < value.Lines.Count; i++)
        {
            var line = value.Lines[i];
            if (errors.Required(line.InvoiceLineId, $"lines[{i}].invoiceLineId") && !seen.Add(line.InvoiceLineId!.Value))
            {
                errors.Add($"lines[{i}].invoiceLineId", "A line may appear only once per credit note.");
            }

            errors.Range(line.AmountMinor, $"lines[{i}].amountMinor", 1, long.MaxValue / 10_000);
        }
    }
}

internal sealed class CreditAdjustmentValidator : IValidator<CreditAdjustmentRequest>
{
    public void Validate(CreditAdjustmentRequest value, ValidationErrors errors)
    {
        if (errors.Range(value.AmountMinor, "amountMinor", -CreatePlanValidator.MaxAmountMinor, CreatePlanValidator.MaxAmountMinor)
            && value.AmountMinor == 0)
        {
            errors.Add("amountMinor", "Must not be zero.");
        }

        errors.Text(value.Reason, "reason", 1, 200);
    }
}
