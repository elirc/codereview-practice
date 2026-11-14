require "test_helper"

class PurchaseFlowTest < ActionDispatch::IntegrationTest
  TURBO_STREAM = { "Accept" => "text/vnd.turbo-stream.html, text/html" }.freeze

  setup do
    travel_to TicketingHelpers::NOW
    PaymentGateway.current = FakeGateway.new
    @tier = ticket_tiers(:general)
    @promo = PromoCode.create!(event: events(:concert), code: "PIER20", kind: "percent", percent_off: 20, stackable: true)
  end

  teardown do
    PaymentGateway.current = nil
  end

  test "holds tickets, applies and removes a promo through turbo streams, and checks out" do
    sign_in_as users(:customer)

    post tier_holds_path(@tier), params: { quantity: 2 }
    hold = users(:customer).holds.sole
    follow_redirect!
    assert_select "turbo-frame#quote #quote-total", text: "$50.00"

    post hold_promos_path(hold), params: { code: " pier20 " }, headers: TURBO_STREAM
    assert_response :success
    assert_equal "text/vnd.turbo-stream.html", response.media_type
    assert_includes response.body, %(<turbo-stream action="replace" target="quote">)
    assert_includes response.body, "$40.00"

    post hold_promos_path(hold), params: { code: "NOT-A-CODE" }, headers: TURBO_STREAM
    assert_response :unprocessable_entity
    assert_includes response.body, %(data-error-code="promo_not_found")

    delete hold_promo_path(hold, @promo.id), headers: TURBO_STREAM
    assert_response :success
    assert_includes response.body, "$50.00"
    assert_empty hold.reload.promo_codes

    post hold_promos_path(hold), params: { code: "PIER20" }, headers: TURBO_STREAM
    post hold_checkout_path(hold), params: { payment_token: "tok_visa" }

    order = users(:customer).orders.sole
    assert_redirected_to order_path(order)
    assert_equal 1_000, order.discount_cents
    assert_equal 4_000, order.total_cents
    assert_equal 1, @promo.reload.redemptions_count
    assert_equal 2, @tier.reload.sold_count
    assert_equal 0, @tier.held_count
  end

  test "without turbo the promo form redirects back to the hold page" do
    sign_in_as users(:customer)
    post tier_holds_path(@tier), params: { quantity: 1 }
    hold = users(:customer).holds.sole

    post hold_promos_path(hold), params: { code: "WRONG" }

    assert_redirected_to hold_path(hold)
    assert_equal "promo_not_found", flash[:error_code]
  end
end
