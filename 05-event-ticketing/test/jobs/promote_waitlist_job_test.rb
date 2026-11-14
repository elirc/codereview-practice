require "test_helper"

class PromoteWaitlistJobTest < ActiveJob::TestCase
  setup do
    @tier = create_tier(capacity: 2)
    @holder, = fill_tier(@tier, 2)
    @entry = join_waitlist(users(:customer), @tier, 2)
  end

  test "is enqueued only after the releasing transaction commits" do
    ApplicationRecord.transaction do
      Holds::Release.call(@holder)
      assert_no_enqueued_jobs(only: PromoteWaitlistJob)
    end

    assert_enqueued_with(job: PromoteWaitlistJob, args: [ @tier.id ])
  end

  test "is not enqueued when the release is rolled back" do
    ApplicationRecord.transaction do
      Holds::Release.call(@holder)
      raise ActiveRecord::Rollback
    end

    assert_no_enqueued_jobs(only: PromoteWaitlistJob)
    assert @holder.reload.active?
  end

  test "offers the freed tickets" do
    Holds::Release.call(@holder)

    travel_to NOW + 1.minute do
      perform_enqueued_jobs(only: PromoteWaitlistJob)
    end

    assert @entry.reload.offered?
  end

  test "a deleted tier is discarded" do
    assert_nothing_raised { PromoteWaitlistJob.perform_now(SecureRandom.uuid) }
  end
end
