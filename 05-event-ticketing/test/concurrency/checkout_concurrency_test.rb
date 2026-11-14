require "test_helper"

class CheckoutConcurrencyTest < ConcurrencyTestCase
  test "checkout racing expiry ends with either an order or an expired hold, never both" do
    tier = concurrent_tier(capacity: 20)
    buyers = customers(5)

    buyers.each do |buyer|
      hold = place_hold(buyer, tier, 2)
      checkout_at = hold.expires_at - 1.second
      expire_at = hold.expires_at + 1.second

      results = run_concurrently(2) do |i|
        if i.zero?
          Checkout::Complete.call(hold: Hold.find(hold.id), user: buyer, payment_token: "tok_visa",
            gateway: @gateway, now: checkout_at)
        else
          Holds::Expire.call(Hold.find(hold.id), now: expire_at)
        end
      end

      hold.reload
      order_count = Order.where(user: buyer).count
      if hold.converted?
        assert results.first.is_a?(Order)
        assert_equal false, results.last
        assert_equal 1, order_count
      else
        assert hold.expired?
        assert_equal :hold_expired, results.first
        assert_equal true, results.last
        assert_equal 0, order_count
      end
    end

    tier.reload
    converted = Hold.converted.where(ticket_tier: tier).sum(:quantity)
    assert_equal 0, tier.held_count
    assert_equal converted, tier.sold_count
    assert_equal converted, Ticket.where(ticket_tier: tier).count
    assert_equal Order.where(event: @event).count, @gateway.charges.size
  end

  test "two checkouts competing for the last redemption of a code: one succeeds" do
    first_tier = concurrent_tier(capacity: 5)
    second_tier = concurrent_tier(capacity: 5)
    PromoCode.create!(event: @event, code: "LASTONE", kind: "percent", percent_off: 50, max_redemptions: 1)
    buyers = customers(2)
    holds = [ place_hold(buyers[0], first_tier, 1), place_hold(buyers[1], second_tier, 1) ]
    holds.each { |hold| apply_promo(hold, "LASTONE") }

    results = run_concurrently(2) do |i|
      Checkout::Complete.call(hold: Hold.find(holds[i].id), user: buyers[i], payment_token: "tok_visa",
        gateway: @gateway, now: NOW + 1.minute)
    end

    assert_equal 1, results.count { |result| result.is_a?(Order) }
    assert_equal [ :promo_exhausted ], results.grep(Symbol)
    assert_equal 1, PromoCode.find_by!(code: "LASTONE").redemptions_count
    assert_equal 1, PromoRedemption.count
    assert_equal 1, holds.count { |hold| hold.reload.active? }
  end

  test "simultaneous double submission charges once and issues one set of tickets" do
    tier = concurrent_tier(capacity: 5)
    buyer = customers(1).first
    hold = place_hold(buyer, tier, 3)

    results = run_concurrently(2) do
      Checkout::Complete.call(hold: Hold.find(hold.id), user: buyer, payment_token: "tok_visa",
        gateway: @gateway, now: NOW + 1.minute)
    end

    assert_equal 1, results.map(&:id).uniq.size
    assert_equal 1, @gateway.charges.size
    assert_equal 3, Ticket.where(ticket_tier: tier).count
    assert_equal 3, tier.reload.sold_count
  end
end
