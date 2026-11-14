require "test_helper"

class Waitlist::PromoteTest < ActiveSupport::TestCase
  include ActionMailer::TestHelper

  setup do
    @tier = create_tier(capacity: 5)
  end

  def promote(now: NOW + 1.minute)
    Waitlist::Promote.call(@tier, now:)
  end

  test "strict queue order: a large entry at the front blocks smaller ones behind it" do
    first_holder, second_holder = fill_tier(@tier, 3, 2)
    a = join_waitlist(create_customer("A"), @tier, 4, now: NOW + 1.second)
    b = join_waitlist(create_customer("B"), @tier, 1, now: NOW + 2.seconds)

    Holds::Release.call(second_holder)
    assert_empty promote

    assert a.reload.waiting?
    assert b.reload.waiting?
    assert_equal 2, @tier.reload.available

    Holds::Release.call(first_holder)
    offers = promote

    assert_equal [ a.id, b.id ], offers.map(&:waitlist_entry_id)
    assert a.reload.offered?
    assert b.reload.offered?
    assert_equal 0, @tier.reload.available
  end

  test "one run offers every entry that fits, in order, and stops at the first that does not" do
    holder, = fill_tier(@tier, 5)
    a = join_waitlist(create_customer("A"), @tier, 1, now: NOW + 1.second)
    b = join_waitlist(create_customer("B"), @tier, 2, now: NOW + 2.seconds)
    c = join_waitlist(create_customer("C"), @tier, 3, now: NOW + 3.seconds)
    d = join_waitlist(create_customer("D"), @tier, 1, now: NOW + 4.seconds)
    Holds::Release.call(holder)

    offers = promote

    assert_equal [ a.id, b.id ], offers.map(&:waitlist_entry_id)
    assert c.reload.waiting?
    assert d.reload.waiting?
    assert_equal 3, @tier.reload.held_count
  end

  test "an offer is a thirty-minute waitlist hold at the current price" do
    holder, = fill_tier(@tier, 5)
    entry = join_waitlist(users(:customer), @tier, 2)
    Holds::Release.call(holder)

    hold = promote(now: NOW + 5.minutes).sole

    assert hold.source_waitlist?
    assert_equal users(:customer), hold.user
    assert_equal 2, hold.quantity
    assert_equal NOW + 35.minutes, hold.expires_at
    entry.reload
    assert_equal NOW + 5.minutes, entry.offered_at
    assert_equal hold.expires_at, entry.offer_expires_at
  end

  test "offers schedule expiry and send the offer mail" do
    holder, = fill_tier(@tier, 5)
    join_waitlist(users(:customer), @tier, 2)
    Holds::Release.call(holder)

    hold = nil
    assert_enqueued_emails 1 do
      hold = promote.sole
    end
    assert_enqueued_with(job: ExpireHoldJob, args: [ hold.id ], at: hold.expires_at)
  end

  test "an expired offer closes the entry and the next entry is offered" do
    holder, = fill_tier(@tier, 5)
    a = join_waitlist(create_customer("A"), @tier, 5, now: NOW + 1.second)
    b = join_waitlist(create_customer("B"), @tier, 5, now: NOW + 2.seconds)
    Holds::Release.call(holder)
    offer = promote.sole

    assert Holds::Expire.call(offer, now: offer.expires_at)
    assert a.reload.expired?
    assert_enqueued_with(job: PromoteWaitlistJob, args: [ @tier.id ])

    next_offer = promote(now: offer.expires_at).sole
    assert_equal b.id, next_offer.waitlist_entry_id
  end

  test "releasing an offered hold expires the entry rather than requeueing it" do
    holder, = fill_tier(@tier, 5)
    a = join_waitlist(create_customer("A"), @tier, 5)
    Holds::Release.call(holder)
    offer = promote.sole

    Holds::Release.call(offer)

    assert a.reload.expired?
    assert_empty promote
  end

  test "promotion stops once sales close" do
    holder, = fill_tier(@tier, 5)
    entry = join_waitlist(users(:customer), @tier, 1)
    Holds::Release.call(holder)

    assert_empty promote(now: @tier.event.sales_close_at)
    assert entry.reload.waiting?
  end

  test "promotion stops when the event is cancelled" do
    holder, = fill_tier(@tier, 5)
    entry = join_waitlist(users(:customer), @tier, 1)
    Holds::Release.call(holder)
    @tier.event.update!(status: :cancelled)

    assert_empty promote
    assert entry.reload.waiting?
  end

  test "an entry whose user already holds tickets directly is cancelled and skipped" do
    direct = place_hold(users(:customer), @tier, 1)
    holder, = fill_tier(@tier, 4)
    mine = join_waitlist(users(:customer), @tier, 1, now: NOW + 1.second)
    theirs = join_waitlist(create_customer("B"), @tier, 1, now: NOW + 2.seconds)
    Holds::Release.call(holder)

    offers = promote

    assert mine.reload.cancelled?
    assert_equal [ theirs.id ], offers.map(&:waitlist_entry_id)
    assert direct.reload.active?
  end

  test "running promotion again does not offer twice" do
    holder, = fill_tier(@tier, 5)
    join_waitlist(users(:customer), @tier, 2)
    Holds::Release.call(holder)

    promote
    assert_empty promote
    assert_equal 2, @tier.reload.held_count
  end

  test "checking out an offer converts the entry" do
    holder, = fill_tier(@tier, 5)
    entry = join_waitlist(users(:customer), @tier, 2)
    Holds::Release.call(holder)
    offer = promote.sole

    Checkout::Complete.call(hold: offer, user: users(:customer), payment_token: "tok_visa",
      gateway: FakeGateway.new, now: NOW + 2.minutes)

    assert entry.reload.converted?
    assert_equal 2, @tier.reload.sold_count
  end
end
