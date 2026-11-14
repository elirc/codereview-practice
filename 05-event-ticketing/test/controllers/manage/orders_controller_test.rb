require "test_helper"

class Manage::OrdersControllerTest < ActionDispatch::IntegrationTest
  setup do
    travel_to TicketingHelpers::NOW
    PaymentGateway.current = FakeGateway.new
    @order = purchase(users(:customer), ticket_tiers(:general), 2, gateway: PaymentGateway.current)
    sign_in_as users(:organizer)
  end

  teardown do
    PaymentGateway.current = nil
  end

  test "lists attendees for the event" do
    get manage_event_orders_path(events(:concert))

    assert_response :success
    assert_select "td", text: /#{users(:customer).email_address}/
  end

  test "refunds once and reports a second attempt" do
    post refund_manage_event_order_path(events(:concert), @order)

    assert @order.reload.refunded?
    assert_redirected_to manage_event_order_path(events(:concert), @order)

    post refund_manage_event_order_path(events(:concert), @order)

    assert_equal "already_refunded", flash[:error_code]
    assert_equal 1, PaymentGateway.current.refunds.size
  end

  test "lowering a tier below what is committed is refused with the error code" do
    patch manage_event_tier_path(events(:concert), ticket_tiers(:general)), params: { ticket_tier: { capacity: 1 } }

    assert_equal "capacity_below_committed", flash[:error_code]
    assert_equal 100, ticket_tiers(:general).reload.capacity
  end

  test "cancelling an event enqueues the cancellation job" do
    post cancel_manage_event_path(events(:concert))

    assert events(:concert).reload.cancelled?
    assert_enqueued_with(job: CancelEventJob, args: [ events(:concert).id ])
  end
end
