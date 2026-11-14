using System.Security.Cryptography;
using System.Text;
using Billing.Domain;
using Xunit;

namespace Billing.Domain.Tests;

public class WebhookSignatureTests
{
    private const string Secret = "whsec_current";
    private const string PreviousSecret = "whsec_previous";
    private static readonly byte[] Body = Encoding.UTF8.GetBytes("{\"id\":\"evt_1\",\"type\":\"invoice.paid\"}");

    [Fact]
    public void ComputeV1IsTheHmacOfTimestampDotBody()
    {
        var expected = Convert.ToHexString(
            HMACSHA256.HashData(Encoding.UTF8.GetBytes(Secret), Encoding.UTF8.GetBytes("1700000000." + Encoding.UTF8.GetString(Body))))
            .ToLowerInvariant();

        Assert.Equal(expected, WebhookSignature.ComputeV1(Secret, 1_700_000_000, Body));
    }

    [Fact]
    public void HeaderVerifiesWithTheCurrentSecret()
    {
        var header = WebhookSignature.Header(1_700_000_000, Body, Secret, null);

        Assert.StartsWith("t=1700000000,v1=", header, StringComparison.Ordinal);
        Assert.True(WebhookSignature.Verify(header, Body, Secret, 1_700_000_010, TimeSpan.FromMinutes(5)));
    }

    [Fact]
    public void HeaderDuringRotationVerifiesWithEitherSecret()
    {
        var header = WebhookSignature.Header(1_700_000_000, Body, Secret, PreviousSecret);

        Assert.Equal(2, header.Split(",v1=").Length - 1);
        Assert.True(WebhookSignature.Verify(header, Body, Secret, 1_700_000_000, TimeSpan.FromMinutes(5)));
        Assert.True(WebhookSignature.Verify(header, Body, PreviousSecret, 1_700_000_000, TimeSpan.FromMinutes(5)));
    }

    [Fact]
    public void HeaderWithoutRotationDoesNotVerifyWithTheOldSecret()
    {
        var header = WebhookSignature.Header(1_700_000_000, Body, Secret, null);

        Assert.False(WebhookSignature.Verify(header, Body, PreviousSecret, 1_700_000_000, TimeSpan.FromMinutes(5)));
    }

    [Fact]
    public void ChangedBodyDoesNotVerify()
    {
        var header = WebhookSignature.Header(1_700_000_000, Body, Secret, null);
        var changed = Encoding.UTF8.GetBytes("{\"id\":\"evt_1\", \"type\":\"invoice.paid\"}");

        Assert.False(WebhookSignature.Verify(header, changed, Secret, 1_700_000_000, TimeSpan.FromMinutes(5)));
    }

    [Fact]
    public void TimestampOutsideToleranceDoesNotVerify()
    {
        var header = WebhookSignature.Header(1_700_000_000, Body, Secret, null);

        Assert.False(WebhookSignature.Verify(header, Body, Secret, 1_700_000_000 + 301, TimeSpan.FromMinutes(5)));
    }

    [Fact]
    public void MalformedHeaderDoesNotVerify()
    {
        Assert.False(WebhookSignature.Verify("garbage", Body, Secret, 1_700_000_000, TimeSpan.FromMinutes(5)));
        Assert.False(WebhookSignature.Verify("t=1700000000", Body, Secret, 1_700_000_000, TimeSpan.FromMinutes(5)));
    }
}
