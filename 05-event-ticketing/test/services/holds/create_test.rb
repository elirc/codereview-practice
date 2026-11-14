require "test_helper"

class Holds::CreateTest < ActiveSupport::TestCase
  setup do
    @user = users(:customer)
    @tier = create_tier(capacity: 5)
  end

  test "holds tickets for ten minutes at the current tier price" do
    hold = place_hold(@user, @tier, 2)

    assert hold.active?
    assert hold.source_direct?
    assert_equal 2, hold.quantity
    assert_equal 1_000, hold.unit_price_cents
    assert_equal NOW + 10.minutes, hold.expires_at
    assert_equal 2, @tier.reload.held_count
  end

  test "schedules expiry at the hold's expiry time" do
    hold = place_hold(@user, @tier, 1)

    assert_enqueued_with(job: ExpireHoldJob, args: [ hold.id ], at: hold.expires_at)
  end

  test "quantity equal to what is available succeeds and one more fails with the available count" do
    place_hold(create_customer, @tier, 2)

    error = assert_domain_error(:insufficient_capacity) { place_hold(@user, @tier, 4) }
    assert_equal 3, error.details[:available]

    hold = place_hold(@user, @tier, 3)
    assert_equal 3, hold.quantity
    assert_equal 0, @tier.reload.available
  end

  test "quantity must be between one and the per-order limit" do
    tier = create_tier(capacity: 50, per_order_limit: 4)

    assert_domain_error(:quantity_invalid) { place_hold(@user, tier, 0) }
    assert_domain_error(:quantity_invalid) { place_hold(@user, tier, 5) }
    assert_equal 4, place_hold(@user, tier, 4).quantity
  end

  test "sales must be open" do
    event = events(:concert)

    assert_domain_error(:sales_closed) { place_hold(@user, @tier, 1, now: event.sales_close_at) }
    assert_domain_error(:sales_closed) { place_hold(@user, ticket_tiers(:draft_general), 1) }

    event.update!(status: :cancelled)
    assert_domain_error(:sales_closed) { place_hold(@user, @tier, 1) }
  end

  test "replacing a hold swaps the quantity in one change and resets the expiry" do
    original = place_hold(@user, @tier, 2)

    replacement = place_hold(@user, @tier, 4, now: NOW + 3.minutes)

    assert original.reload.released?
    assert replacement.active?
    assert_equal NOW + 13.minutes, replacement.expires_at
    assert_equal 4, @tier.reload.held_count
  end

  test "a replacement that does not fit keeps the original hold and expiry" do
    original = place_hold(@user, @tier, 2)
    place_hold(create_customer, @tier, 2)

    error = assert_domain_error(:insufficient_capacity) { place_hold(@user, @tier, 4, now: NOW + 1.minute) }

    assert_equal 1, error.details[:available]
    original.reload
    assert original.active?
    assert_equal NOW + 10.minutes, original.expires_at
    assert_equal 4, @tier.reload.held_count
  end

  test "the per-event cap counts live holds across tiers" do
    other_tier = create_tier(capacity: 20, name: "Other room")
    place_hold(@user, other_tier, 5)

    assert_domain_error(:event_limit_exceeded) { place_hold(@user, @tier, 4) }
    assert_equal 3, place_hold(@user, @tier, 3).quantity
  end

  test "the per-event cap excludes the hold being replaced" do
    big_tier = create_tier(capacity: 20, per_order_limit: 8, name: "Big room")
    place_hold(@user, big_tier, 6)

    assert_equal 8, place_hold(@user, big_tier, 8).quantity
  end

  test "holds expired by time do not count toward the cap" do
    other_tier = create_tier(capacity: 20, name: "Other room")
    place_hold(@user, other_tier, 6)

    hold = place_hold(@user, @tier, 5, now: NOW + 10.minutes)

    assert_equal 5, hold.quantity
  end

  test "holds on other events do not count toward the cap" do
    place_hold(@user, ticket_tiers(:rival_general), 6)

    assert_equal 5, place_hold(@user, @tier, 5).quantity
  end
end
