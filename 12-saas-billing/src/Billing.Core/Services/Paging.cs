using Billing.Core.Errors;

namespace Billing.Core.Services;

/// <summary>A cursor page request: rows after the given cursor, at most <see cref="Limit"/> of them.</summary>
public sealed record PageRequest(string? After, int Limit)
{
    public const int DefaultLimit = 50;
    public const int MaxLimit = 200;

    /// <summary>Returns the cursor as an id; throws a validation error when it is not one.</summary>
    public Guid? AfterId()
    {
        if (After is null)
        {
            return null;
        }

        return Guid.TryParse(After, out var id) ? id : throw DomainException.Validation("after", "Must be a cursor returned by a previous page.");
    }
}

/// <summary>One page of results and the cursor of the next page, if there is one.</summary>
public sealed record Page<T>(IReadOnlyList<T> Data, string? NextCursor);

public static class Paging
{
    /// <summary>Builds a page from up to <c>limit + 1</c> rows ordered by cursor.</summary>
    public static Page<TView> Build<TRow, TView>(IReadOnlyList<TRow> rows, int limit, Func<TRow, string> cursor, Func<TRow, TView> map)
    {
        var hasMore = rows.Count > limit;
        var pageRows = hasMore ? rows.Take(limit).ToList() : rows.ToList();
        var next = hasMore ? cursor(pageRows[^1]) : null;
        return new Page<TView>(pageRows.Select(map).ToList(), next);
    }
}
