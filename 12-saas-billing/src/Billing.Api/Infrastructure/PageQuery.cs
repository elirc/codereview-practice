using Billing.Core.Errors;
using Billing.Core.Services;

namespace Billing.Api.Infrastructure;

/// <summary>Parses the <c>after</c> and <c>limit</c> query parameters.</summary>
public static class PageQuery
{
    public static PageRequest Parse(string? after, int? limit)
    {
        if (limit is < 1 or > PageRequest.MaxLimit)
        {
            throw DomainException.Validation("limit", $"Must be between 1 and {PageRequest.MaxLimit}.");
        }

        if (after is { Length: > 200 })
        {
            throw DomainException.Validation("after", "Must be a cursor returned by a previous page.");
        }

        return new PageRequest(string.IsNullOrEmpty(after) ? null : after, limit ?? PageRequest.DefaultLimit);
    }
}
