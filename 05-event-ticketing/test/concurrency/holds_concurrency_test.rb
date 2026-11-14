require "test_helper"

class HoldsConcurrencyTest < ConcurrencyTestCase
  test "concurrent holds never take more than the capacity" do
    tier = concurrent_tier(capacity: 5)
    buyers = customers(10)

    results = run_concurrently(buyers.size) { |i| place_hold(buyers[i], tier, 1) }

    assert_equal 5, results.count { |result| result.is_a?(Hold) }
    assert_equal 5, results.count(:insufficient_capacity)
    tier.reload
    assert_equal 5, tier.held_count
    assert_equal 5, Hold.active.where(ticket_tier: tier).sum(:quantity)
  end

  test "two buyers wanting the last two tickets: exactly one gets them" do
    tier = concurrent_tier(capacity: 2)
    buyers = customers(2)

    results = run_concurrently(2) { |i| place_hold(buyers[i], tier, 2) }

    assert_equal 1, results.count { |result| result.is_a?(Hold) }
    assert_equal [ :insufficient_capacity ], results.grep(Symbol)
    assert_equal 2, tier.reload.held_count
  end

  test "an expiry job and the sweep racing on one hold return its tickets once" do
    tier = concurrent_tier(capacity: 4)
    hold = place_hold(customers(1).first, tier, 3)
    later = hold.expires_at + 1.second

    results = run_concurrently(2) { Holds::Expire.call(Hold.find(hold.id), now: later) }

    assert_equal [ false, true ], results.sort_by { |result| result ? 1 : 0 }
    assert hold.reload.expired?
    assert_equal 0, tier.reload.held_count
  end
end
