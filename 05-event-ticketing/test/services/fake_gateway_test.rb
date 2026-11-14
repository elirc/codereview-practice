require "test_helper"

class FakeGatewayTest < ActiveSupport::TestCase
  setup do
    @gateway = FakeGateway.new
  end

  test "repeating an idempotency key returns the original approval" do
    first = @gateway.charge(amount_cents: 500, token: "tok_visa", idempotency_key: "hold-1")
    second = @gateway.charge(amount_cents: 500, token: "tok_visa", idempotency_key: "hold-1")

    assert first.approved?
    assert_equal first, second
    assert_equal 1, @gateway.charges.size
  end

  test "declines in decline mode or for the decline token" do
    assert_not @gateway.charge(amount_cents: 500, token: FakeGateway::DECLINE_TOKEN, idempotency_key: "k1").approved?

    @gateway.mode = :decline
    assert_not @gateway.charge(amount_cents: 500, token: "tok_visa", idempotency_key: "k2").approved?
    assert_empty @gateway.charges
  end

  test "a voided charge can be charged again under the same key" do
    first = @gateway.charge(amount_cents: 500, token: "tok_visa", idempotency_key: "hold-1")
    @gateway.void(first.reference)

    second = @gateway.charge(amount_cents: 500, token: "tok_visa", idempotency_key: "hold-1")

    assert_not_equal first.reference, second.reference
    assert_equal [ first.reference ], @gateway.voids
  end

  test "records refunds" do
    result = @gateway.refund("fake_ch_9", amount_cents: 1_200)

    assert result.approved?
    assert_equal [ { reference: "fake_ch_9", amount_cents: 1_200 } ], @gateway.refunds
  end
end
