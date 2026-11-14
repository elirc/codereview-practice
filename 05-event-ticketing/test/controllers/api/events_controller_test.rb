require "test_helper"

class Api::EventsControllerTest < ActionDispatch::IntegrationTest
  setup do
    travel_to TicketingHelpers::NOW
  end

  test "reports availability for every tier of a published event" do
    general = ticket_tiers(:general)
    general.update_columns(sold_count: 95, held_count: 5)

    get availability_api_event_path(events(:concert))

    assert_response :success
    tiers = response.parsed_body["tiers"].index_by { |tier| tier["id"] }
    assert_equal({ "id" => general.id, "available" => 0, "waitlist_open" => true }, tiers[general.id])
    assert_equal({ "id" => ticket_tiers(:vip).id, "available" => 10, "waitlist_open" => false }, tiers[ticket_tiers(:vip).id])
  end

  test "the waitlist stays open while entries are pending even with free tickets" do
    tier = ticket_tiers(:vip)
    tier.update_columns(sold_count: 10)
    Waitlist::Join.call(user: users(:customer), tier:, quantity: 1, now: TicketingHelpers::NOW)
    tier.update_columns(sold_count: 8)

    get availability_api_event_path(events(:concert))

    vip = response.parsed_body["tiers"].find { |entry| entry["id"] == tier.id }
    assert_equal 2, vip["available"]
    assert vip["waitlist_open"]
  end

  test "draft events are not found, with the error envelope and request id" do
    get availability_api_event_path(events(:draft_show)), headers: { "X-Request-Id" => "req-abc-123" }

    assert_response :not_found
    error = response.parsed_body["error"]
    assert_equal "not_found", error["code"]
    assert_equal "req-abc-123", error["request_id"]
    assert error["message"].present?
  end

  test "malformed ids are not found" do
    get availability_api_event_path("not-a-uuid")

    assert_response :not_found
    assert_equal "not_found", response.parsed_body.dig("error", "code")
  end

  test "cancelled events are not found" do
    events(:concert).update!(status: :cancelled)

    get availability_api_event_path(events(:concert))

    assert_response :not_found
  end
end
