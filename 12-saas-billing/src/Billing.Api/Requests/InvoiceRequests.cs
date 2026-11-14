using Billing.Api.Validation;
using Billing.Core.Services;

namespace Billing.Api.Requests;

public sealed record ManualLineRequest(string? Description, long? Quantity, long? UnitAmountMinor)
{
    public ManualLine ToLine() => new(Description!, Quantity!.Value, UnitAmountMinor!.Value);
}

public sealed record CreateInvoiceRequest(Guid? CustomerId, IReadOnlyList<ManualLineRequest>? Lines);

public sealed record ReplaceInvoiceLinesRequest(IReadOnlyList<ManualLineRequest>? Lines);

internal static class ManualLineRules
{
    public const int MaxLines = 100;

    public static void Validate(IReadOnlyList<ManualLineRequest>? lines, ValidationErrors errors)
    {
        if (lines is null || lines.Count is 0 or > MaxLines)
        {
            errors.Add("lines", $"Between 1 and {MaxLines} lines are required.");
            return;
        }

        for (var i = 0; i < lines.Count; i++)
        {
            errors.Text(lines[i].Description, $"lines[{i}].description", 1, 200);
            errors.Range(lines[i].Quantity, $"lines[{i}].quantity", 1, 1_000_000);
            errors.Range(lines[i].UnitAmountMinor, $"lines[{i}].unitAmountMinor", 1, CreatePlanValidator.MaxAmountMinor);
        }
    }
}

internal sealed class CreateInvoiceValidator : IValidator<CreateInvoiceRequest>
{
    public void Validate(CreateInvoiceRequest value, ValidationErrors errors)
    {
        errors.Required(value.CustomerId, "customerId");
        ManualLineRules.Validate(value.Lines, errors);
    }
}

internal sealed class ReplaceInvoiceLinesValidator : IValidator<ReplaceInvoiceLinesRequest>
{
    public void Validate(ReplaceInvoiceLinesRequest value, ValidationErrors errors) =>
        ManualLineRules.Validate(value.Lines, errors);
}
