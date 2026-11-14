require "test_helper"

class CheckoutsControllerTest < ActionDispatch::IntegrationTest
  setup do
    travel_to TicketingHelpers::NOW
    PaymentGateway.current = FakeGateway.new
    sign_in_as users(:customer)
    post tier_holds_path(ticket_tiers(:general)), params: { quantity: 2 }
    @hold = users(:customer).holds.sole
  end

  teardown do
    PaymentGateway.current = nil
  end

  test "pays and redirects to the order" do
    post hold_checkout_path(@hold), params: { payment_token: "tok_visa" }

    order = users(:customer).orders.sole
    assert_redirected_to order_path(order)
    follow_redirect!
    assert_select "code", count: 2
  end

  test "a second submission goes to the existing order without another charge" do
    post hold_checkout_path(@hold), params: { payment_token: "tok_visa" }
    post hold_checkout_path(@hold), params: { payment_token: "tok_visa" }

    order = users(:customer).orders.sole
    assert_redirected_to order_path(order)
    assert_equal 1, PaymentGateway.current.charges.size
  end

  test "a decline returns to the hold page with the error code" do
    post hold_checkout_path(@hold), params: { payment_token: FakeGateway::DECLINE_TOKEN }

    assert_redirected_to hold_path(@hold)
    assert_equal "payment_declined", flash[:error_code]
    assert @hold.reload.active?
  end

  test "the hold page of a converted hold redirects to its order" do
    post hold_checkout_path(@hold), params: { payment_token: "tok_visa" }

    get hold_path(@hold)

    assert_redirected_to order_path(@hold.reload.order)
  end

  test "a missing token is a validation failure" do
    post hold_checkout_path(@hold), params: {}

    assert_equal "validation_failed", flash[:error_code]
  end
end
