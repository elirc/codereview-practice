require "test_helper"

class EventsControllerTest < ActionDispatch::IntegrationTest
  test "lists published events only" do
    get root_path

    assert_response :success
    assert_select "a", text: events(:concert).title
    assert_select "a", text: events(:draft_show).title, count: 0
  end

  test "shows a published event to guests" do
    get event_path(events(:concert))

    assert_response :success
    assert_select "td", text: ticket_tiers(:vip).name
  end

  test "draft events are not found for guests and customers" do
    get event_path(events(:draft_show))
    assert_response :not_found

    sign_in_as users(:customer)
    get event_path(events(:draft_show))
    assert_response :not_found
  end

  test "the organiser can preview a draft" do
    sign_in_as users(:organizer)

    get event_path(events(:draft_show))

    assert_response :success
  end
end
