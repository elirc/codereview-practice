require "test_helper"

class Manage::TiersControllerTest < ActionDispatch::IntegrationTest
  setup do
    sign_in_as users(:organizer)
  end

  test "adds a tier to an event" do
    assert_difference -> { events(:concert).ticket_tiers.count }, 1 do
      post manage_event_tiers_path(events(:concert)), params: {
        ticket_tier: { name: "Balcony", price_cents: 3500, capacity: 40, per_order_limit: 4, position: 2 }
      }
    end

    tier = events(:concert).ticket_tiers.find_by!(name: "Balcony")
    assert_equal 0, tier.sold_count
    assert_equal 0, tier.held_count
    assert_redirected_to manage_event_path(events(:concert))
  end

  test "counters cannot be set through the form" do
    tier = ticket_tiers(:general)

    patch manage_event_tier_path(events(:concert), tier), params: { ticket_tier: { name: "GA", sold_count: 99 } }

    assert_equal "GA", tier.reload.name
    assert_equal 0, tier.sold_count
  end

  test "invalid tiers re-render" do
    post manage_event_tiers_path(events(:concert)), params: { ticket_tier: { name: "", price_cents: -5, capacity: 1 } }

    assert_response :unprocessable_entity
    assert_select "li[data-field=price_cents]"
  end
end
