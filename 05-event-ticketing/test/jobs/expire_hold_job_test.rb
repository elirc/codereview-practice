require "test_helper"

class ExpireHoldJobTest < ActiveJob::TestCase
  setup do
    @tier = create_tier(capacity: 5)
    @hold = place_hold(users(:customer), @tier, 2)
  end

  test "expires the hold once its time has come" do
    travel_to @hold.expires_at do
      ExpireHoldJob.perform_now(@hold.id)
    end

    assert @hold.reload.expired?
    assert_equal 0, @tier.reload.held_count
  end

  test "running early leaves the hold alone" do
    travel_to @hold.expires_at - 30.seconds do
      ExpireHoldJob.perform_now(@hold.id)
    end

    assert @hold.reload.active?
    assert_equal 2, @tier.reload.held_count
  end

  test "running twice changes the counts once" do
    travel_to @hold.expires_at + 1.minute do
      2.times { ExpireHoldJob.perform_now(@hold.id) }
    end

    assert_equal 0, @tier.reload.held_count
  end

  test "a missing hold is discarded" do
    assert_nothing_raised { ExpireHoldJob.perform_now(SecureRandom.uuid) }
  end
end
