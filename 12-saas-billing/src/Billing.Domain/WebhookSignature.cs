using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace Billing.Domain;

/// <summary>Builds and checks the <c>Billing-Signature</c> header of webhook requests.</summary>
public static class WebhookSignature
{
    /// <summary>Returns the lower-case hex HMAC-SHA256 of <c>"&lt;timestamp&gt;." + body</c> keyed with the secret.</summary>
    public static string ComputeV1(string secret, long timestamp, ReadOnlySpan<byte> body)
    {
        var prefix = Encoding.UTF8.GetBytes(timestamp.ToString(CultureInfo.InvariantCulture) + ".");
        var payload = new byte[prefix.Length + body.Length];
        prefix.CopyTo(payload, 0);
        body.CopyTo(payload.AsSpan(prefix.Length));

        var mac = HMACSHA256.HashData(Encoding.UTF8.GetBytes(secret), payload);
        return Convert.ToHexString(mac).ToLowerInvariant();
    }

    /// <summary>Returns <c>t=&lt;timestamp&gt;,v1=&lt;hex&gt;</c>, with a second <c>v1</c> for the previous secret when one is given.</summary>
    public static string Header(long timestamp, ReadOnlySpan<byte> body, string secret, string? previousSecret)
    {
        var header = new StringBuilder();
        header.Append(CultureInfo.InvariantCulture, $"t={timestamp},v1={ComputeV1(secret, timestamp, body)}");
        if (previousSecret is not null)
        {
            header.Append(CultureInfo.InvariantCulture, $",v1={ComputeV1(previousSecret, timestamp, body)}");
        }

        return header.ToString();
    }

    /// <summary>
    /// Returns whether the header carries a <c>v1</c> signature of <paramref name="body"/> made with
    /// <paramref name="secret"/> and a timestamp within <paramref name="tolerance"/> of <paramref name="nowUnixSeconds"/>.
    /// </summary>
    public static bool Verify(string header, ReadOnlySpan<byte> body, string secret, long nowUnixSeconds, TimeSpan tolerance)
    {
        long? timestamp = null;
        var signatures = new List<string>();
        foreach (var part in header.Split(',', StringSplitOptions.TrimEntries))
        {
            var separator = part.IndexOf('=');
            if (separator <= 0)
            {
                return false;
            }

            var name = part[..separator];
            var value = part[(separator + 1)..];
            if (name == "t" && long.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out var parsed))
            {
                timestamp = parsed;
            }
            else if (name == "v1")
            {
                signatures.Add(value);
            }
        }

        if (timestamp is null || signatures.Count == 0 || Math.Abs(nowUnixSeconds - timestamp.Value) > (long)tolerance.TotalSeconds)
        {
            return false;
        }

        var expected = Encoding.ASCII.GetBytes(ComputeV1(secret, timestamp.Value, body));
        foreach (var signature in signatures)
        {
            if (CryptographicOperations.FixedTimeEquals(expected, Encoding.ASCII.GetBytes(signature)))
            {
                return true;
            }
        }

        return false;
    }
}
