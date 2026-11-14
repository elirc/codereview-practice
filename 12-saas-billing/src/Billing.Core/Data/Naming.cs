using System.Diagnostics.CodeAnalysis;
using System.Text;
using Microsoft.EntityFrameworkCore.Storage.ValueConversion;

namespace Billing.Core.Data;

/// <summary>Snake-case naming for database identifiers and enum values.</summary>
public static class Naming
{
    /// <summary>Returns <paramref name="name"/> in lower snake case, e.g. <c>PastDue</c> becomes <c>past_due</c>.</summary>
    public static string ToSnakeCase(string name)
    {
        var builder = new StringBuilder(name.Length + 8);
        for (var i = 0; i < name.Length; i++)
        {
            var c = name[i];
            if (char.IsUpper(c))
            {
                var previous = i > 0 ? name[i - 1] : '_';
                var nextIsLower = i + 1 < name.Length && char.IsLower(name[i + 1]);
                if (previous != '_' && (char.IsLower(previous) || char.IsDigit(previous) || (char.IsUpper(previous) && nextIsLower)))
                {
                    builder.Append('_');
                }

                builder.Append(char.ToLowerInvariant(c));
            }
            else
            {
                builder.Append(c);
            }
        }

        return builder.ToString();
    }

    /// <summary>Returns the stored text of an enum value.</summary>
    public static string EnumValue<TEnum>(TEnum value)
        where TEnum : struct, Enum =>
        EnumNames<TEnum>.ToText[value];

    /// <summary>Returns the enum value for stored text; throws for unknown text.</summary>
    public static TEnum ParseEnum<TEnum>(string text)
        where TEnum : struct, Enum =>
        EnumNames<TEnum>.FromText.TryGetValue(text, out var value)
            ? value
            : throw new FormatException($"\"{text}\" is not a valid {typeof(TEnum).Name}.");

    /// <summary>Parses stored text into an enum value; returns false for unknown text.</summary>
    public static bool TryParseEnum<TEnum>([NotNullWhen(true)] string? text, out TEnum value)
        where TEnum : struct, Enum
    {
        value = default;
        return text is not null && EnumNames<TEnum>.FromText.TryGetValue(text, out value);
    }

    private static class EnumNames<TEnum>
        where TEnum : struct, Enum
    {
        public static readonly Dictionary<TEnum, string> ToText =
            Enum.GetValues<TEnum>().ToDictionary(v => v, v => ToSnakeCase(v.ToString()));

        public static readonly Dictionary<string, TEnum> FromText =
            ToText.ToDictionary(p => p.Value, p => p.Key, StringComparer.Ordinal);
    }
}

/// <summary>Stores an enum as its snake-case name.</summary>
public sealed class SnakeCaseEnumConverter<TEnum>()
    : ValueConverter<TEnum, string>(v => Naming.EnumValue(v), s => Naming.ParseEnum<TEnum>(s))
    where TEnum : struct, Enum;
