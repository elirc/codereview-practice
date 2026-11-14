require "test_helper"

class SweepExpiredHoldsJobTest < ActiveJob::TestCase
  setup do
    @tier = create_tier(capacity: 10)
  end

  test "expires every active hold whose time has passed and leaves live ones" do
    stale = place_hold(users(:customer), @tier, 2)
    also_stale = place_hold(users(:other_customer), @tier, 3)
    fresh = place_hold(users(:organizer), @tier, 1, now: NOW + 5.minutes)

    travel_to NOW + 10.minutes do
      SweepExpiredHoldsJob.perform_now
    end

    assert stale.reload.expired?
    assert also_stale.reload.expired?
    assert fresh.reload.active?
    assert_equal 1, @tier.reload.held_count
  end

  test "sweeping after the expiry job already ran changes nothing" do
    hold = place_hold(users(:customer), @tier, 2)

    travel_to hold.expires_at do
      ExpireHoldJob.perform_now(hold.id)
      SweepExpiredHoldsJob.perform_now
    end

    assert_equal 0, @tier.reload.held_count
  end
end
