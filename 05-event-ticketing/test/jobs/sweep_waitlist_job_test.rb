require "test_helper"

class SweepWaitlistJobTest < ActiveJob::TestCase
  test "enqueues promotion for tiers with waiting entries and free tickets only" do
    freed = create_tier(capacity: 2, name: "Freed")
    full = create_tier(capacity: 2, name: "Full")
    quiet = create_tier(capacity: 2, name: "Quiet")

    freed_holder, = fill_tier(freed, 2)
    fill_tier(full, 2)
    join_waitlist(users(:customer), freed, 2)
    join_waitlist(users(:customer), full, 2)
    freed_holder.update_columns(status: "released")
    freed.update_columns(held_count: 0)
    clear_enqueued_jobs

    SweepWaitlistJob.perform_now

    assert_enqueued_jobs 1, only: PromoteWaitlistJob
    assert_enqueued_with(job: PromoteWaitlistJob, args: [ freed.id ])
    assert_equal 2, quiet.reload.available
  end
end
