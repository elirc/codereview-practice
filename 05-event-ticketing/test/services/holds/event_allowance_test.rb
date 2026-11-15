require "test_helper"

class Holds::EventAllowanceTest < ActiveSupport::TestCase
  setup do
    @user = users(:customer)
    @event = events(:concert)
    @tier = create_tier(capacity: 10)
  end

  def remaining(now: NOW)
    Holds::EventAllowance.remaining(user: @user, event: @event, now:)
  end

  test "a new customer can get the full allowance" do
    assert_equal 8, remaining
  end

  test "counts paid tickets, live holds and waiting entries" do
    purchase(@user, @tier, 2, gateway: FakeGateway.new)
    place_hold(@user, create_tier(capacity: 10, name: "Other room"), 3)
    full = create_tier(capacity: 1, name: "Tiny room")
    fill_tier(full, 1)
    join_waitlist(@user, full, 1)

    assert_equal 2, remaining
  end

  test "holds past their expiry no longer count" do
    hold = place_hold(@user, @tier, 5)

    assert_equal 3, remaining
    assert_equal 8, remaining(now: hold.expires_at)
  end

  test "reaches zero at the limit" do
    place_hold(@user, @tier, 6)
    place_hold(@user, create_tier(capacity: 10, name: "Other room"), 2)

    assert_equal 0, remaining
  end
end
