using Billing.Domain;
using Xunit;

namespace Billing.Domain.Tests;

public class CreditNoteMathTests
{
    [Fact]
    public void CreditOfTheWholeLineTakesTheWholeLineTax()
    {
        Assert.Equal(133, CreditNoteMath.LineTax(1613, 1613, 0, 133, 0, 825));
    }

    [Fact]
    public void PartialCreditTakesTheRoundedRateShare()
    {
        Assert.Equal(41, CreditNoteMath.LineTax(500, 1613, 0, 133, 0, 825));
    }

    [Fact]
    public void FinalPartOfASplitCreditTakesTheRemainingTax()
    {
        var first = CreditNoteMath.LineTax(15, 33, 0, 3, 0, 1000);
        var second = CreditNoteMath.LineTax(18, 33, 15, 3, first, 1000);

        Assert.Equal(2, first);
        Assert.Equal(1, second);
        Assert.Equal(3, first + second);
    }

    [Fact]
    public void PartialCreditsNeverTakeMoreTaxThanTheLineCarried()
    {
        const long lineAmount = 25;
        const long lineTax = 3;
        long credited = 0;
        long creditedTax = 0;

        for (var i = 0; i < 5; i++)
        {
            var tax = CreditNoteMath.LineTax(5, lineAmount, credited, lineTax, creditedTax, 1000);
            credited += 5;
            creditedTax += tax;
        }

        Assert.Equal(lineAmount, credited);
        Assert.Equal(lineTax, creditedTax);
    }

    [Fact]
    public void CreditBeyondTheRemainingAmountIsRejected()
    {
        Assert.Throws<ArgumentOutOfRangeException>(() => CreditNoteMath.LineTax(20, 33, 15, 3, 2, 1000));
    }
}
