require "test_helper"

class Checkout::PromoCheckoutTest < ActiveSupport::TestCase
  setup do
    @tier = create_tier(capacity: 10, price_cents: 1_000)
    @gateway = FakeGateway.new
  end

  def checkout(hold, now: NOW + 1.minute)
    Checkout::Complete.call(hold:, user: hold.user, payment_token: "tok_visa", gateway: @gateway, now:)
  end

  test "records redemptions and charges the discounted total" do
    promo = create_promo("TENOFF", percent_off: 10, stackable: true)
    fixed = create_promo("FIVE", amount_off_cents: 500, stackable: true)
    hold = place_hold(users(:customer), @tier, 3)
    apply_promo(hold, "FIVE")
    apply_promo(hold, "TENOFF")

    order = checkout(hold)

    assert_equal 3_000, order.subtotal_cents
    assert_equal 800, order.discount_cents
    assert_equal 2_200, order.total_cents
    assert_equal 2_200, @gateway.charges.sole[:amount_cents]
    assert_equal({ promo.id => 300, fixed.id => 500 }, order.promo_redemptions.to_h { |r| [ r.promo_code_id, r.amount_cents ] })
    assert_equal 1, promo.reload.redemptions_count
    assert_equal 1, fixed.reload.redemptions_count
  end

  test "a code redeemed by someone else first fails with promo_exhausted until it is removed" do
    promo = create_promo("ONEONLY", percent_off: 20, max_redemptions: 1)
    first = place_hold(users(:customer), @tier, 1)
    second = place_hold(users(:other_customer), @tier, 1)
    apply_promo(first, "oneonly")
    apply_promo(second, "oneonly")

    checkout(first)
    error = assert_domain_error(:promo_exhausted) { checkout(second) }
    assert_equal "ONEONLY", error.details[:promo_code]

    second.reload
    assert second.active?
    assert_equal NOW + 10.minutes, second.expires_at

    second.hold_promos.find_by!(promo_code: promo).destroy!
    assert_equal 1_000, checkout(second).total_cents
    assert_equal 1, promo.reload.redemptions_count
  end

  test "a code whose window ends between apply and checkout fails at checkout" do
    create_promo("SHORT", percent_off: 10, ends_at: NOW + 2.minutes)
    hold = place_hold(users(:customer), @tier, 1)
    apply_promo(hold, "SHORT")

    assert_domain_error(:promo_not_active) { checkout(hold, now: NOW + 2.minutes) }
    assert hold.reload.active?
    assert_empty @gateway.charges
  end

  test "a code deactivated after apply fails at checkout" do
    promo = create_promo("GONE", percent_off: 10)
    hold = place_hold(users(:customer), @tier, 1)
    apply_promo(hold, "GONE")
    promo.update!(active: false)

    assert_domain_error(:promo_not_found) { checkout(hold) }
  end

  test "a fixed discount above the total makes it free without calling the gateway" do
    promo = create_promo("BIGFIX", amount_off_cents: 50_000)
    hold = place_hold(users(:customer), @tier, 2)
    apply_promo(hold, "BIGFIX")

    order = checkout(hold)

    assert_equal 0, order.total_cents
    assert_equal 2_000, order.discount_cents
    assert_equal 2_000, order.promo_redemptions.sole.amount_cents
    assert_empty @gateway.charges
    assert_equal 1, promo.reload.redemptions_count
  end

  test "the per-user limit counts the user's earlier orders" do
    create_promo("REPEAT", amount_off_cents: 100, per_user_limit: 1)
    first = place_hold(users(:customer), @tier, 1)
    apply_promo(first, "REPEAT")
    checkout(first)

    second = place_hold(users(:customer), @tier, 1, now: NOW + 2.minutes)
    assert_domain_error(:promo_user_limit) { apply_promo(second, "REPEAT", now: NOW + 2.minutes) }
  end

  test "a declined payment records no redemption" do
    promo = create_promo("DECLINED", percent_off: 10)
    hold = place_hold(users(:customer), @tier, 1)
    apply_promo(hold, "DECLINED")
    @gateway.mode = :decline

    assert_domain_error(:payment_declined) { checkout(hold) }
    assert_equal 0, promo.reload.redemptions_count
    assert_equal 0, PromoRedemption.count
  end
end
