require "test_helper"

class AuthorizationTest < ActionDispatch::IntegrationTest
  setup do
    travel_to TicketingHelpers::NOW
    PaymentGateway.current = FakeGateway.new
    @tier = ticket_tiers(:general)
    @foreign_hold = place_hold(users(:other_customer), @tier, 1)
    @foreign_order = purchase(users(:other_customer), ticket_tiers(:vip), 1, gateway: PaymentGateway.current)
  end

  teardown do
    PaymentGateway.current = nil
  end

  test "guests must sign in for anything beyond browsing" do
    get orders_path
    assert_redirected_to new_session_path

    get hold_path(@foreign_hold)
    assert_redirected_to new_session_path

    get manage_events_path
    assert_redirected_to new_session_path
  end

  test "another customer's hold is not found" do
    sign_in_as users(:customer)

    get hold_path(@foreign_hold)
    assert_response :not_found

    delete hold_path(@foreign_hold)
    assert_response :not_found

    post hold_checkout_path(@foreign_hold), params: { payment_token: "tok_visa" }
    assert_response :not_found

    post hold_promos_path(@foreign_hold), params: { code: "ANY" }
    assert_response :not_found

    assert @foreign_hold.reload.active?
  end

  test "another customer's order is not found" do
    sign_in_as users(:customer)

    get order_path(@foreign_order)

    assert_response :not_found
  end

  test "another customer's waitlist entry is not found" do
    entry = WaitlistEntry.create!(user: users(:other_customer), ticket_tier: @tier, quantity: 1)
    sign_in_as users(:customer)

    delete waitlist_entry_path(entry)

    assert_response :not_found
    assert entry.reload.waiting?
  end

  test "draft events are hidden from customers and other organisers but not admins" do
    draft = events(:draft_show)

    sign_in_as users(:customer)
    get event_path(draft)
    assert_response :not_found
    post tier_holds_path(ticket_tiers(:draft_general)), params: { quantity: 1 }
    assert_response :not_found
    post tier_waitlist_entries_path(ticket_tiers(:draft_general)), params: { quantity: 1 }
    assert_response :not_found

    sign_in_as users(:other_organizer)
    get event_path(draft)
    assert_response :not_found

    sign_in_as users(:admin)
    get event_path(draft)
    assert_response :success
  end

  test "customers cannot reach the management area" do
    sign_in_as users(:customer)

    get manage_events_path
    assert_response :forbidden

    post refund_manage_event_order_path(events(:concert), @foreign_order)
    assert_response :forbidden
    assert @foreign_order.reload.paid?
  end

  test "organisers cannot manage another organiser's event" do
    event = events(:rival_festival)
    tier = ticket_tiers(:rival_general)
    sign_in_as users(:organizer)

    [
      -> { get manage_event_path(event) },
      -> { get edit_manage_event_path(event) },
      -> { patch manage_event_path(event), params: { event: { title: "Mine now" } } },
      -> { post cancel_manage_event_path(event) },
      -> { get new_manage_event_tier_path(event) },
      -> { patch manage_event_tier_path(event, tier), params: { ticket_tier: { capacity: 1 } } },
      -> { get manage_event_promo_codes_path(event) },
      -> { post manage_event_promo_codes_path(event), params: { promo_code: { code: "X", kind: "percent", percent_off: 5 } } },
      -> { get manage_event_orders_path(event) },
      -> { get manage_event_waitlist_entries_path(event) }
    ].each do |request|
      request.call
      assert_response :not_found
    end

    event.reload
    assert_equal "Rival Folk Festival", event.title
    assert event.published?
    assert_equal 200, tier.reload.capacity
    assert_empty event.promo_codes
  end

  test "an order cannot be reached through a different event" do
    sign_in_as users(:other_organizer)

    get manage_event_order_path(events(:rival_festival), @foreign_order)

    assert_response :not_found
  end

  test "admins manage any event" do
    sign_in_as users(:admin)

    get manage_event_path(events(:rival_festival))
    assert_response :success

    get manage_event_orders_path(events(:concert))
    assert_response :success
  end
end
