require "test_helper"

class Checkout::CompleteTest < ActiveSupport::TestCase
  include ActionMailer::TestHelper

  setup do
    @user = users(:customer)
    @tier = create_tier(capacity: 5, price_cents: 2_000)
    @hold = place_hold(@user, @tier, 2)
    @gateway = FakeGateway.new
  end

  def checkout(hold = @hold, user: @user, now: NOW + 1.minute, token: "tok_visa", **options)
    Checkout::Complete.call(hold:, user:, payment_token: token, gateway: @gateway, now:, **options)
  end

  test "converts the hold into a paid order with tickets" do
    order = checkout

    assert order.paid?
    assert_match Order::NUMBER_FORMAT, order.number
    assert_equal 4_000, order.subtotal_cents
    assert_equal 0, order.discount_cents
    assert_equal 4_000, order.total_cents
    assert_equal 2, order.tickets.status_valid.count
    assert order.tickets.all? { |ticket| ticket.code.match?(/\A[A-Z2-7]{12}\z/) }

    @hold.reload
    assert @hold.converted?
    assert_equal order, @hold.order

    @tier.reload
    assert_equal 0, @tier.held_count
    assert_equal 2, @tier.sold_count
  end

  test "charges the total once with the hold idempotency key" do
    order = checkout

    assert_equal [ { amount_cents: 4_000, idempotency_key: "hold-#{@hold.id}", reference: order.payment_reference } ],
      @gateway.charges
  end

  test "sends the confirmation after commit" do
    assert_enqueued_emails 1 do
      checkout
    end
  end

  test "fails at the exact expiry instant and succeeds one second before" do
    assert_domain_error(:hold_expired) { checkout(now: @hold.expires_at) }
    assert @hold.reload.active?
    assert_empty @gateway.charges

    assert checkout(now: @hold.expires_at - 1.second).paid?
  end

  test "a hold expired by time but not yet swept cannot be checked out" do
    assert_domain_error(:hold_expired) { checkout(now: @hold.expires_at + 3.minutes) }

    assert_equal 2, @tier.reload.held_count
    assert_equal 0, Order.count
  end

  test "another user's hold cannot be checked out" do
    assert_domain_error(:hold_expired) { checkout(user: users(:other_customer)) }
    assert @hold.reload.active?
  end

  test "a declined payment keeps the hold and its expiry" do
    @gateway.mode = :decline

    assert_domain_error(:payment_declined) { checkout }

    @hold.reload
    assert @hold.active?
    assert_equal NOW + 10.minutes, @hold.expires_at
    assert_equal 0, Order.count
    assert_equal 2, @tier.reload.held_count
  end

  test "the decline token is refused and a later attempt can succeed" do
    assert_domain_error(:payment_declined) { checkout(token: FakeGateway::DECLINE_TOKEN) }

    assert checkout(token: "tok_visa").paid?
  end

  test "a zero total skips the gateway" do
    free_tier = create_tier(capacity: 5, price_cents: 0, name: "Free room")
    hold = place_hold(users(:other_customer), free_tier, 3)

    order = checkout(hold, user: users(:other_customer))

    assert_equal 0, order.total_cents
    assert_nil order.payment_reference
    assert_empty @gateway.charges
    assert_equal 3, order.tickets.count
  end

  test "submitting twice returns the same order with one charge and one set of tickets" do
    first = nil
    assert_enqueued_emails 1 do
      first = checkout
      second = checkout(now: NOW + 2.minutes)
      assert_equal first, second
    end

    assert_equal 1, @gateway.charges.size
    assert_equal 2, Ticket.where(order: first).count
    assert_equal 2, @tier.reload.sold_count
  end

  test "voids the charge when the order cannot be saved after payment" do
    repeating = ->(length) { "A" * length }

    assert_raises(ActiveRecord::RecordNotUnique) { checkout(token_generator: repeating) }

    assert_equal 1, @gateway.charges.size
    assert_equal [ @gateway.charges.first[:reference] ], @gateway.voids
    assert @hold.reload.active?
    assert_equal 0, Order.count
    assert_equal 2, @tier.reload.held_count
  end

  test "a live hold can still be checked out after sales close" do
    event = @tier.event
    event.update!(sales_close_at: NOW + 30.seconds)

    assert checkout(now: NOW + 1.minute).paid?
  end

  test "a cancelled event refuses checkout" do
    @tier.event.update!(status: :cancelled)

    assert_domain_error(:event_cancelled) { checkout }
    assert @hold.reload.active?
  end

  test "the hold's stored unit price is charged after a price change" do
    @tier.update!(price_cents: 9_999)

    assert_equal 4_000, checkout.total_cents
  end

  test "paid tickets count toward the per-event cap" do
    checkout

    roomy = create_tier(capacity: 20, per_order_limit: 8, name: "Roomy")

    assert_domain_error(:event_limit_exceeded) { place_hold(@user, roomy, 7) }
    assert_equal 6, place_hold(@user, roomy, 6).quantity
  end
end
