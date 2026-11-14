require "test_helper"

class Waitlist::LeaveTest < ActiveSupport::TestCase
  setup do
    @tier = create_tier(capacity: 2)
    @holder, = fill_tier(@tier, 2)
  end

  test "leaving while waiting cancels the entry and reruns promotion" do
    entry = join_waitlist(users(:customer), @tier, 1)

    Waitlist::Leave.call(entry)

    assert entry.reload.cancelled?
    assert_enqueued_with(job: PromoteWaitlistJob, args: [ @tier.id ])
  end

  test "leaving with an offer releases the hold and the next entry can be offered" do
    a = join_waitlist(create_customer("A"), @tier, 2, now: NOW + 1.second)
    b = join_waitlist(create_customer("B"), @tier, 2, now: NOW + 2.seconds)
    Holds::Release.call(@holder)
    offer = Waitlist::Promote.call(@tier, now: NOW + 1.minute).sole

    Waitlist::Leave.call(a)

    assert a.reload.cancelled?
    assert offer.reload.released?
    assert_equal 0, @tier.reload.held_count

    next_offer = Waitlist::Promote.call(@tier, now: NOW + 2.minutes).sole
    assert_equal b.id, next_offer.waitlist_entry_id
  end

  test "a closed entry cannot be left" do
    entry = join_waitlist(users(:customer), @tier, 1)
    Waitlist::Leave.call(entry)

    assert_domain_error(:waitlist_entry_closed) { Waitlist::Leave.call(entry) }
  end
end
