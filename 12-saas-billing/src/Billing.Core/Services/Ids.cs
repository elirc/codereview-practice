using System.Security.Cryptography;
using System.Text;

namespace Billing.Core.Services;

/// <summary>Creates time-ordered identifiers from the injected clock.</summary>
public static class Ids
{
    public static Guid New(TimeProvider clock) => Guid.CreateVersion7(clock.GetUtcNow());
}

/// <summary>Produces random tokens such as API keys and webhook secrets.</summary>
public interface ISecretGenerator
{
    /// <summary>Returns <paramref name="prefix"/> followed by 32 random bytes in base64url.</summary>
    string NewToken(string prefix);
}

/// <summary>Generates tokens from the operating system's cryptographic random source.</summary>
public sealed class RandomSecretGenerator : ISecretGenerator
{
    public string NewToken(string prefix) => prefix + Base64Url(RandomNumberGenerator.GetBytes(32));

    private static string Base64Url(byte[] bytes) =>
        Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
}

/// <summary>Hashing used to store API keys and request fingerprints.</summary>
public static class Hashing
{
    /// <summary>Returns the lower-case hex SHA-256 of the UTF-8 text.</summary>
    public static string Sha256Hex(string text) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(text))).ToLowerInvariant();
}
