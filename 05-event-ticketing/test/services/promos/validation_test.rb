require "test_helper"

class Promos::ValidationTest < ActiveSupport::TestCase
  setup do
    @user = users(:customer)
    @tier = create_tier(capacity: 10, price_cents: 1_000)
    @hold = place_hold(@user, @tier, 2)
    @validation = Promos::Validation.new(hold: @hold, user: @user, now: NOW)
  end

  def error_for(code, now: NOW)
    Promos::Validation.new(hold: @hold, user: @user, now:).error_for(code)
  end

  test "a valid code has no error" do
    assert_nil error_for(create_promo("OK10", percent_off: 10))
  end

  test "inactive codes and codes from other events are not found" do
    assert_equal :promo_not_found, error_for(create_promo("OFF", percent_off: 10, active: false))
    assert_equal :promo_not_found, error_for(create_promo("ELSEWHERE", percent_off: 10, event: events(:rival_festival)))
  end

  test "site-wide codes apply to any event" do
    assert_nil error_for(create_promo("EVERYWHERE", percent_off: 5, event: nil))
  end

  test "the window includes its start and excludes its end" do
    code = create_promo("WINDOW", percent_off: 10, starts_at: NOW, ends_at: NOW + 1.hour)

    assert_equal :promo_not_active, error_for(code, now: NOW - 1.second)
    assert_nil error_for(code, now: NOW)
    assert_nil error_for(code, now: NOW + 1.hour - 1.second)
    assert_equal :promo_not_active, error_for(code, now: NOW + 1.hour)
  end

  test "tier restrictions" do
    elsewhere = create_promo("VIPONLY", percent_off: 10)
    elsewhere.ticket_tiers << ticket_tiers(:vip)
    here = create_promo("SMALLROOM", percent_off: 10)
    here.ticket_tiers << @tier

    assert_equal :promo_not_applicable, error_for(elsewhere)
    assert_nil error_for(here)
  end

  test "minimum subtotal" do
    assert_equal :promo_min_not_met, error_for(create_promo("MIN", amount_off_cents: 100, min_subtotal_cents: 2_001))
    assert_nil error_for(create_promo("MINOK", amount_off_cents: 100, min_subtotal_cents: 2_000))
  end

  test "exhausted codes" do
    code = create_promo("ONCE", percent_off: 10, max_redemptions: 1)
    code.update_columns(redemptions_count: 1)

    assert_equal :promo_exhausted, error_for(code)
  end

  test "per-user limit counts the user's redemptions" do
    code = create_promo("MINE", percent_off: 10, per_user_limit: 1)
    order = Order.create!(user: @user, event: events(:concert), number: "ORD-AAAAAAAA", subtotal_cents: 100,
      discount_cents: 10, total_cents: 90)
    PromoRedemption.create!(promo_code: code, order:, user: @user, amount_cents: 10)

    assert_equal :promo_user_limit, error_for(code)
    assert_nil Promos::Validation.new(hold: @hold, user: users(:other_customer), now: NOW).error_for(code)
  end

  test "stacking rules" do
    stack_pct = create_promo("SPCT", percent_off: 10, stackable: true)
    stack_pct2 = create_promo("SPCT2", percent_off: 5, stackable: true)
    stack_fix = create_promo("SFIX", amount_off_cents: 100, stackable: true)
    stack_fix2 = create_promo("SFIX2", amount_off_cents: 200, stackable: true)
    solo = create_promo("SOLO", amount_off_cents: 100, stackable: false)

    assert_nil Promos::Validation.stacking_error([ solo ])
    assert_nil Promos::Validation.stacking_error([ stack_pct, stack_fix ])
    assert_nil Promos::Validation.stacking_error([ stack_fix, stack_fix2 ])
    assert_equal :promo_not_stackable, Promos::Validation.stacking_error([ stack_pct, stack_pct2 ])
    assert_equal :promo_not_stackable, Promos::Validation.stacking_error([ solo, stack_fix ])
    assert_equal :promo_not_stackable, Promos::Validation.stacking_error([ stack_fix, solo ])
    assert_equal :promo_not_stackable, Promos::Validation.stacking_error([ stack_fix, stack_fix ])
    assert_equal :promo_not_stackable, Promos::Validation.stacking_error([ stack_pct, stack_fix, stack_fix2 ])
  end
end
