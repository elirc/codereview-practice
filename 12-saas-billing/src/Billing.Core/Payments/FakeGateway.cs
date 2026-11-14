using System.Globalization;

namespace Billing.Core.Payments;

/// <summary>
/// An in-memory gateway scripted by payment token and recording every call:
/// <c>tok_ok</c> succeeds; <c>tok_decline_&lt;code&gt;</c> is declined with that code;
/// <c>tok_timeout_then_ok</c> is processed but times out; <c>tok_timeout_unprocessed</c> times out without
/// being processed; <c>tok_ok_then_crash</c> is processed and then fails with a connection error;
/// <c>tok_ok_refund_fails</c> succeeds but its refunds fail. Any other token is declined as <c>invalid_token</c>.
/// </summary>
public sealed class FakeGateway : IPaymentGateway
{
    private readonly object _gate = new();
    private readonly Dictionary<string, (GatewayResult Result, string Token)> _charges = new(StringComparer.Ordinal);
    private readonly Dictionary<string, string> _refunds = new(StringComparer.Ordinal);
    private readonly HashSet<string> _failingRefundCharges = new(StringComparer.Ordinal);
    private readonly List<string> _chargeCalls = [];
    private readonly List<string> _lookupCalls = [];
    private readonly List<(string ChargeId, long AmountMinor, string IdempotencyKey)> _refundCalls = [];
    private int _sequence;

    /// <summary>Idempotency keys of every charge call, in call order.</summary>
    public IReadOnlyList<string> ChargeCalls
    {
        get
        {
            lock (_gate)
            {
                return [.. _chargeCalls];
            }
        }
    }

    /// <summary>Idempotency keys of every lookup call, in call order.</summary>
    public IReadOnlyList<string> LookupCalls
    {
        get
        {
            lock (_gate)
            {
                return [.. _lookupCalls];
            }
        }
    }

    /// <summary>Every refund call, in call order.</summary>
    public IReadOnlyList<(string ChargeId, long AmountMinor, string IdempotencyKey)> RefundCalls
    {
        get
        {
            lock (_gate)
            {
                return [.. _refundCalls];
            }
        }
    }

    /// <summary>Number of charges that were actually processed as successful.</summary>
    public int SuccessfulCharges
    {
        get
        {
            lock (_gate)
            {
                return _charges.Values.Count(c => c.Result is GatewayResult.Succeeded);
            }
        }
    }

    public Task<GatewayResult> ChargeAsync(string token, long amountMinor, string currency, string idempotencyKey, CancellationToken ct)
    {
        lock (_gate)
        {
            _chargeCalls.Add(idempotencyKey);
            if (_charges.TryGetValue(idempotencyKey, out var earlier))
            {
                return Task.FromResult(earlier.Result);
            }

            switch (token)
            {
                case "tok_ok":
                    return Task.FromResult(Store(idempotencyKey, token, NewCharge()));
                case "tok_ok_refund_fails":
                    {
                        var charge = NewCharge();
                        _failingRefundCharges.Add(charge.ChargeId);
                        return Task.FromResult(Store(idempotencyKey, token, charge));
                    }

                case "tok_timeout_then_ok":
                    Store(idempotencyKey, token, NewCharge());
                    throw new GatewayTimeoutException("The gateway did not respond in time.");
                case "tok_timeout_unprocessed":
                    throw new GatewayTimeoutException("The gateway did not respond in time.");
                case "tok_ok_then_crash":
                    Store(idempotencyKey, token, NewCharge());
                    throw new IOException("The connection was reset after the request was sent.");
                default:
                    {
                        var code = token.StartsWith("tok_decline_", StringComparison.Ordinal) ? token["tok_decline_".Length..] : "invalid_token";
                        return Task.FromResult(Store(idempotencyKey, token, new GatewayResult.Declined(code)));
                    }
            }
        }
    }

    public Task<GatewayResult> LookupAsync(string idempotencyKey, CancellationToken ct)
    {
        lock (_gate)
        {
            _lookupCalls.Add(idempotencyKey);
            return Task.FromResult(_charges.TryGetValue(idempotencyKey, out var charge) ? charge.Result : new GatewayResult.NotFound());
        }
    }

    public Task<string> RefundAsync(string chargeId, long amountMinor, string idempotencyKey, CancellationToken ct)
    {
        lock (_gate)
        {
            _refundCalls.Add((chargeId, amountMinor, idempotencyKey));
            if (_refunds.TryGetValue(idempotencyKey, out var existing))
            {
                return Task.FromResult(existing);
            }

            if (_failingRefundCharges.Contains(chargeId))
            {
                throw new PaymentGatewayException("The refund was refused by the gateway.");
            }

            var refundId = "re_" + (++_sequence).ToString(CultureInfo.InvariantCulture);
            _refunds[idempotencyKey] = refundId;
            return Task.FromResult(refundId);
        }
    }

    /// <summary>Forgets every charge, refund and recorded call.</summary>
    public void Reset()
    {
        lock (_gate)
        {
            _charges.Clear();
            _refunds.Clear();
            _failingRefundCharges.Clear();
            _chargeCalls.Clear();
            _lookupCalls.Clear();
            _refundCalls.Clear();
            _sequence = 0;
        }
    }

    private GatewayResult.Succeeded NewCharge() => new("ch_" + (++_sequence).ToString(CultureInfo.InvariantCulture));

    private GatewayResult Store(string idempotencyKey, string token, GatewayResult result)
    {
        _charges[idempotencyKey] = (result, token);
        return result;
    }
}
