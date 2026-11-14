require "test_helper"

class Orders::RefundTest < ActiveSupport::TestCase
  include ActionMailer::TestHelper

  setup do
    @gateway = FakeGateway.new
    @tier = create_tier(capacity: 4, price_cents: 1_500)
    @order = purchase(users(:customer), @tier, 3, gateway: @gateway)
  end

  def refund(order = @order, now: NOW + 1.hour)
    Orders::Refund.call(order, gateway: @gateway, now:)
  end

  test "voids the tickets, frees the capacity and refunds the payment" do
    refund

    @order.reload
    assert @order.refunded?
    assert_equal NOW + 1.hour, @order.refunded_at
    assert @order.tickets.all?(&:status_void?)
    assert_equal 0, @tier.reload.sold_count
    assert_equal [ { reference: @order.payment_reference, amount_cents: 4_500 } ], @gateway.refunds
  end

  test "triggers promotion and sends the refund mail after commit" do
    assert_enqueued_emails 1 do
      refund
    end
    assert_enqueued_with(job: PromoteWaitlistJob, args: [ @tier.id ])
  end

  test "freed tickets go to the waitlist" do
    join_waitlist(users(:other_customer), @tier, 2)

    refund
    offer = Waitlist::Promote.call(@tier, now: NOW + 2.hours).sole

    assert_equal users(:other_customer), offer.user
  end

  test "a second refund changes nothing" do
    refund

    assert_domain_error(:already_refunded) { refund }
    assert_equal 1, @gateway.refunds.size
    assert_equal 0, @tier.reload.sold_count
  end

  test "promo redemptions stay counted and still apply to the per-user limit" do
    promo = create_promo("ONCEEACH", amount_off_cents: 100, per_user_limit: 1)
    hold = place_hold(users(:other_customer), @tier, 1)
    apply_promo(hold, "ONCEEACH")
    order = Checkout::Complete.call(hold:, user: users(:other_customer), payment_token: "tok_visa",
      gateway: @gateway, now: NOW + 1.minute)

    refund(order)

    assert_equal 1, promo.reload.redemptions_count
    assert_equal 1, order.promo_redemptions.count
    next_hold = place_hold(users(:other_customer), @tier, 1, now: NOW + 2.hours)
    assert_domain_error(:promo_user_limit) { apply_promo(next_hold, "ONCEEACH", now: NOW + 2.hours) }
  end

  test "a free order is refunded without calling the gateway" do
    free_tier = create_tier(capacity: 2, price_cents: 0, name: "Free")
    order = purchase(users(:other_customer), free_tier, 1, gateway: @gateway)

    refund(order)

    assert order.reload.refunded?
    assert_empty @gateway.refunds
  end

  test "a failed provider refund leaves the order paid" do
    failing = Class.new(FakeGateway) do
      def refund(reference, amount_cents:)
        PaymentGateway::Result.new(status: :declined, reference:, message: "unavailable")
      end
    end.new

    assert_domain_error(:refund_failed) { Orders::Refund.call(@order, gateway: failing, now: NOW + 1.hour) }
    assert @order.reload.paid?
    assert_equal 3, @tier.reload.sold_count
    assert @order.tickets.all?(&:status_valid?)
  end
end
