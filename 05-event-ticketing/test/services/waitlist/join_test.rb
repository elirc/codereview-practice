require "test_helper"

class Waitlist::JoinTest < ActiveSupport::TestCase
  setup do
    @tier = create_tier(capacity: 4)
    @user = users(:customer)
  end

  test "joining is refused while tickets are available and nobody is waiting" do
    error = assert_domain_error(:tickets_available) { join_waitlist(@user, @tier, 2) }

    assert_equal 4, error.details[:available]
  end

  test "joining is allowed when fewer tickets are free than requested" do
    fill_tier(@tier, 3)

    entry = join_waitlist(@user, @tier, 2)

    assert entry.waiting?
    assert_equal 1, entry.position
  end

  test "once someone is waiting, anyone may join even if tickets are free" do
    fill_tier(@tier, 3)
    join_waitlist(create_customer, @tier, 2)

    entry = join_waitlist(@user, @tier, 1, now: NOW + 1.second)

    assert_equal 2, entry.position
  end

  test "direct holds are refused while the waitlist has entries" do
    fill_tier(@tier, 3)
    join_waitlist(create_customer, @tier, 2)

    assert_equal 1, @tier.reload.available
    assert_domain_error(:waitlist_active) { place_hold(@user, @tier, 1) }
  end

  test "one open entry per user per tier" do
    fill_tier(@tier, 4)
    join_waitlist(@user, @tier, 1)

    assert_domain_error(:already_waitlisted) { join_waitlist(@user, @tier, 2) }
  end

  test "quantity and sales window rules apply" do
    fill_tier(@tier, 4)

    assert_domain_error(:quantity_invalid) { join_waitlist(@user, @tier, 7) }
    assert_domain_error(:sales_closed) { join_waitlist(@user, @tier, 1, now: @tier.event.sales_close_at) }
  end

  test "the per-event cap counts the requested quantity" do
    fill_tier(@tier, 4)
    place_hold(@user, create_tier(capacity: 10, name: "Other room"), 5)

    assert_domain_error(:event_limit_exceeded) { join_waitlist(@user, @tier, 4) }
    assert join_waitlist(@user, @tier, 3).waiting?
  end
end
