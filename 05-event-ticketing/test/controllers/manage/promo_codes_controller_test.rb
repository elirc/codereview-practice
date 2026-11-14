require "test_helper"

class Manage::PromoCodesControllerTest < ActionDispatch::IntegrationTest
  setup do
    sign_in_as users(:organizer)
    @event = events(:concert)
  end

  test "creates an upper-case code restricted to chosen tiers of the event" do
    post manage_event_promo_codes_path(@event), params: { promo_code: {
      code: "early bird", kind: "percent", percent_off: 15, per_user_limit: 1, min_subtotal_cents: 0,
      ticket_tier_ids: [ "", ticket_tiers(:vip).id, ticket_tiers(:rival_general).id ]
    } }

    assert_response :unprocessable_entity
    assert_select "li[data-field=code]"

    post manage_event_promo_codes_path(@event), params: { promo_code: {
      code: "early_bird", kind: "percent", percent_off: 15, per_user_limit: 1, min_subtotal_cents: 0,
      ticket_tier_ids: [ "", ticket_tiers(:vip).id, ticket_tiers(:rival_general).id ]
    } }

    promo = @event.promo_codes.find_by!(code: "EARLY_BIRD")
    assert_equal [ ticket_tiers(:vip) ], promo.ticket_tiers.to_a
    assert_redirected_to manage_event_promo_codes_path(@event)
  end

  test "rejects a percent code with an amount" do
    post manage_event_promo_codes_path(@event), params: { promo_code: {
      code: "MIXED", kind: "percent", percent_off: 10, amount_off_cents: 100, per_user_limit: 1, min_subtotal_cents: 0
    } }

    assert_response :unprocessable_entity
    assert_select "li[data-field=amount_off_cents]"
  end

  test "an invalid update leaves the tier restriction unchanged" do
    promo = PromoCode.create!(event: @event, code: "KEEP", kind: "fixed", amount_off_cents: 100)
    promo.ticket_tiers << ticket_tiers(:general)

    patch manage_event_promo_code_path(@event, promo), params: { promo_code: {
      amount_off_cents: 0, ticket_tier_ids: [ "", ticket_tiers(:vip).id ]
    } }

    assert_response :unprocessable_entity
    assert_equal [ ticket_tiers(:general) ], promo.reload.ticket_tiers.to_a
  end

  test "redemption counters cannot be edited" do
    promo = PromoCode.create!(event: @event, code: "COUNT", kind: "fixed", amount_off_cents: 100)

    patch manage_event_promo_code_path(@event, promo), params: { promo_code: { redemptions_count: 50, active: "0" } }

    promo.reload
    assert_equal 0, promo.redemptions_count
    assert_not promo.active?
  end
end
