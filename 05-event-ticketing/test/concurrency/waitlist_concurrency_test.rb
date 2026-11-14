require "test_helper"

class WaitlistConcurrencyTest < ConcurrencyTestCase
  test "concurrent promotions offer each entry once and never exceed capacity" do
    tier = concurrent_tier(capacity: 4)
    filler = place_hold(customers(1).first, tier, 4)
    waiting = customers(5).each_with_index.map do |user, i|
      join_waitlist(user, tier, 1, now: NOW + i.seconds)
    end
    Holds::Release.call(filler)

    run_concurrently(4) { Waitlist::Promote.call(TicketTier.find(tier.id), now: NOW + 1.minute) }

    offers = Hold.source_waitlist.where(ticket_tier: tier)
    assert_equal 4, offers.count
    assert_equal 4, offers.distinct.count(:waitlist_entry_id)
    assert_equal waiting.first(4).map(&:id).sort, offers.pluck(:waitlist_entry_id).sort
    assert waiting.last.reload.waiting?
    assert_equal 4, tier.reload.held_count
  end
end
