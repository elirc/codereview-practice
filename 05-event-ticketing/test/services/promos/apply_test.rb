require "test_helper"

class Promos::ApplyTest < ActiveSupport::TestCase
  setup do
    @tier = create_tier(capacity: 10, price_cents: 1_000)
    @hold = place_hold(users(:customer), @tier, 2)
  end

  test "matches codes case-insensitively after trimming whitespace" do
    promo = create_promo("summer10", percent_off: 10)
    assert_equal "SUMMER10", promo.code

    assert_equal promo, apply_promo(@hold, " summer10 ")
    assert_equal [ promo ], @hold.reload.promo_codes
  end

  test "unknown, blank and foreign codes are not found" do
    create_promo("RIVAL", percent_off: 10, event: events(:rival_festival))

    assert_domain_error(:promo_not_found) { apply_promo(@hold, "NOPE") }
    assert_domain_error(:promo_not_found) { apply_promo(@hold, "   ") }
    assert_domain_error(:promo_not_found) { apply_promo(@hold, "rival") }
  end

  test "a code restricted to another tier does not apply" do
    promo = create_promo("VIPONLY", percent_off: 10)
    promo.ticket_tiers << ticket_tiers(:vip)

    assert_domain_error(:promo_not_applicable) { apply_promo(@hold, "VIPONLY") }
  end

  test "an event code is preferred over a site-wide code with the same text" do
    create_promo("SHARED", percent_off: 50, event: nil)
    event_code = create_promo("SHARED", percent_off: 10)

    assert_equal event_code, apply_promo(@hold, "shared")
  end

  test "a non-stackable code is rejected whichever is added first" do
    create_promo("SOLO", amount_off_cents: 100)
    create_promo("STACK", amount_off_cents: 200, stackable: true)

    apply_promo(@hold, "SOLO")
    assert_domain_error(:promo_not_stackable) { apply_promo(@hold, "STACK") }

    other = place_hold(users(:other_customer), @tier, 1)
    apply_promo(other, "STACK")
    assert_domain_error(:promo_not_stackable) { apply_promo(other, "SOLO") }
  end

  test "two stackable percent codes are rejected; percent plus fixed is allowed" do
    create_promo("P10", percent_off: 10, stackable: true)
    create_promo("P20", percent_off: 20, stackable: true)
    create_promo("F5", amount_off_cents: 500, stackable: true)

    apply_promo(@hold, "P10")
    assert_domain_error(:promo_not_stackable) { apply_promo(@hold, "P20") }
    apply_promo(@hold, "F5")

    assert_equal %w[ F5 P10 ], @hold.reload.promo_codes.map(&:code).sort
  end

  test "the same code cannot be applied twice" do
    create_promo("TWICE", amount_off_cents: 100, stackable: true)

    apply_promo(@hold, "TWICE")
    assert_domain_error(:promo_not_stackable) { apply_promo(@hold, "twice") }
  end

  test "applying does not consume a redemption or extend the hold" do
    promo = create_promo("LIMITED", percent_off: 10, max_redemptions: 1)

    apply_promo(@hold, "LIMITED", now: NOW + 5.minutes)

    assert_equal 0, promo.reload.redemptions_count
    assert_equal NOW + 10.minutes, @hold.reload.expires_at
  end

  test "codes cannot be applied to a hold that is expired by time" do
    create_promo("LATE", percent_off: 10)

    assert_domain_error(:hold_expired) { apply_promo(@hold, "LATE", now: @hold.expires_at) }
  end

  test "codes cannot be applied to another user's hold" do
    create_promo("MINE", percent_off: 10)

    assert_domain_error(:hold_expired) { apply_promo(@hold, "MINE", user: users(:other_customer)) }
  end
end
