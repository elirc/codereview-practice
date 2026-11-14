require "test_helper"

class Holds::ExpireAndReleaseTest < ActiveSupport::TestCase
  setup do
    @tier = create_tier(capacity: 5)
    @hold = place_hold(users(:customer), @tier, 3)
  end

  test "expiring returns the tickets once" do
    assert Holds::Expire.call(@hold, now: @hold.expires_at)
    assert_not Holds::Expire.call(@hold, now: @hold.expires_at + 1.minute)

    assert @hold.reload.expired?
    assert_equal 0, @tier.reload.held_count
  end

  test "expiring before the expiry time does nothing" do
    assert_not Holds::Expire.call(@hold, now: @hold.expires_at - 1.second)

    assert @hold.reload.active?
    assert_equal 3, @tier.reload.held_count
  end

  test "an expired-by-time hold keeps its tickets until expiry runs" do
    later = @hold.expires_at + 5.minutes

    assert_not @hold.live?(later)
    assert_equal 2, @tier.reload.available
    assert_domain_error(:insufficient_capacity) { place_hold(users(:other_customer), @tier, 3, now: later) }
  end

  test "releasing returns the tickets once" do
    assert Holds::Release.call(@hold)
    assert_not Holds::Release.call(@hold)

    assert @hold.reload.released?
    assert_equal 0, @tier.reload.held_count
  end

  test "an expired hold cannot be released and a released hold cannot expire" do
    Holds::Release.call(@hold)

    assert_not Holds::Expire.call(@hold, now: @hold.expires_at)
    assert @hold.reload.released?
    assert_equal 0, @tier.reload.held_count
  end

  test "a stale copy of the hold is re-read under the lock" do
    stale = Hold.find(@hold.id)
    Holds::Expire.call(@hold, now: @hold.expires_at)

    assert_not Holds::Release.call(stale)
    assert_equal 0, @tier.reload.held_count
  end
end
