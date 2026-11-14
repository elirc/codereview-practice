using Billing.Domain;
using Xunit;

namespace Billing.Domain.Tests;

public class ScheduleTests
{
    [Theory]
    [InlineData(1, 3)]
    [InlineData(2, 5)]
    [InlineData(3, 7)]
    public void DunningRetriesAfterThreeFiveAndSevenDays(int declines, int days)
    {
        Assert.Equal(TimeSpan.FromDays(days), DunningSchedule.RetryDelay(declines));
    }

    [Fact]
    public void DunningStopsAtTheFourthDecline()
    {
        Assert.Null(DunningSchedule.RetryDelay(4));
        Assert.Equal(4, DunningSchedule.MaxDeclines);
    }

    [Fact]
    public void WebhookRetriesFollowTheSchedule()
    {
        var delays = Enumerable.Range(1, 7).Select(WebhookRetrySchedule.RetryDelay).ToArray();

        Assert.Equal(
            new TimeSpan?[]
            {
                TimeSpan.FromMinutes(1),
                TimeSpan.FromMinutes(5),
                TimeSpan.FromMinutes(30),
                TimeSpan.FromHours(2),
                TimeSpan.FromHours(6),
                TimeSpan.FromHours(12),
                TimeSpan.FromHours(24),
            },
            delays);
    }

    [Fact]
    public void WebhookDeliveryFailsForGoodAtTheEighthFailure()
    {
        Assert.Null(WebhookRetrySchedule.RetryDelay(8));
    }

    [Theory]
    [InlineData(1, "INV-2026-000001")]
    [InlineData(123_456, "INV-2026-123456")]
    public void DocumentNumbersArePaddedToSixDigits(long sequence, string expected)
    {
        Assert.Equal(expected, DocumentNumbers.Format(DocumentNumbers.InvoicePrefix, 2026, sequence));
    }
}
