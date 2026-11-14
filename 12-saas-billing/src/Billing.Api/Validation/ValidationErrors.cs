using System.Text.RegularExpressions;
using Billing.Core.Errors;

namespace Billing.Api.Validation;

/// <summary>Collects field errors and offers the common checks used by the validators.</summary>
public sealed class ValidationErrors
{
    private readonly List<FieldError> _fields = [];

    public IReadOnlyList<FieldError> Fields => _fields;

    public bool HasErrors => _fields.Count > 0;

    public void Add(string path, string message) => _fields.Add(new FieldError(path, message));

    /// <summary>Records an error when the value is null; returns whether it was present.</summary>
    public bool Required<T>(T? value, string path)
    {
        if (value is null)
        {
            Add(path, "Is required.");
            return false;
        }

        return true;
    }

    /// <summary>Checks a string's presence and length; returns whether it is valid.</summary>
    public bool Text(string? value, string path, int min, int max, bool required = true)
    {
        if (value is null)
        {
            if (required)
            {
                Add(path, "Is required.");
                return false;
            }

            return true;
        }

        if (value.Trim().Length < min || value.Length > max)
        {
            Add(path, $"Must be between {min} and {max} characters.");
            return false;
        }

        return true;
    }

    /// <summary>Checks a string against a pattern after the presence and length checks.</summary>
    public bool Matches(string? value, string path, Regex pattern, string message, bool required = true)
    {
        if (value is null)
        {
            if (required)
            {
                Add(path, "Is required.");
                return false;
            }

            return true;
        }

        if (!pattern.IsMatch(value))
        {
            Add(path, message);
            return false;
        }

        return true;
    }

    /// <summary>Checks a number's presence and range; returns whether it is valid.</summary>
    public bool Range(long? value, string path, long min, long max, bool required = true)
    {
        if (value is null)
        {
            if (required)
            {
                Add(path, "Is required.");
                return false;
            }

            return true;
        }

        if (value < min || value > max)
        {
            Add(path, $"Must be between {min} and {max}.");
            return false;
        }

        return true;
    }
}
