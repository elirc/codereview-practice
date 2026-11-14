require "test_helper"

class HoldsControllerTest < ActionDispatch::IntegrationTest
  setup do
    travel_to TicketingHelpers::NOW
    @tier = ticket_tiers(:general)
  end

  test "guests are sent to sign in" do
    post tier_holds_path(@tier), params: { quantity: 2 }

    assert_redirected_to new_session_path
  end

  test "creates a hold and shows the checkout page" do
    sign_in_as users(:customer)

    post tier_holds_path(@tier), params: { quantity: 2 }

    hold = users(:customer).holds.sole
    assert_redirected_to hold_path(hold)
    follow_redirect!
    assert_response :success
    assert_select "h1", /Checkout/
  end

  test "business rule failures come back as a flash with the error code" do
    sign_in_as users(:customer)

    post tier_holds_path(@tier), params: { quantity: 99 }

    assert_redirected_to event_path(events(:concert))
    assert_equal "quantity_invalid", flash[:error_code]
  end

  test "a non-numeric quantity is a validation failure" do
    sign_in_as users(:customer)

    post tier_holds_path(@tier), params: { quantity: "lots" }

    assert_equal "validation_failed", flash[:error_code]
    assert_empty users(:customer).holds
  end

  test "holds cannot be placed on draft events" do
    sign_in_as users(:customer)

    post tier_holds_path(ticket_tiers(:draft_general)), params: { quantity: 1 }

    assert_response :not_found
  end

  test "releasing a hold returns the tickets" do
    sign_in_as users(:customer)
    post tier_holds_path(@tier), params: { quantity: 2 }
    hold = users(:customer).holds.sole

    delete hold_path(hold)

    assert hold.reload.released?
    assert_equal 0, @tier.reload.held_count
    assert_redirected_to event_path(events(:concert))
  end
end
