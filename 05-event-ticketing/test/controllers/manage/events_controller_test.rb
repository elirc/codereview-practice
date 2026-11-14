require "test_helper"

class Manage::EventsControllerTest < ActionDispatch::IntegrationTest
  test "organiser creates a draft with times in the event zone" do
    sign_in_as users(:organizer)

    assert_difference -> { users(:organizer).organized_events.count }, 1 do
      post manage_events_path, params: { event: {
        title: "Late Show", venue: "Club", time_zone: "Europe/London",
        starts_at_local: "2030-08-01T21:00", ends_at_local: "2030-08-01T23:30", sales_close_at_local: ""
      } }
    end

    event = Event.order(:created_at).last
    assert event.draft?
    assert_equal Time.utc(2030, 8, 1, 20, 0), event.starts_at
    assert_equal event.starts_at, event.sales_close_at
    assert_redirected_to manage_event_path(event)
  end

  test "invalid events re-render the form" do
    sign_in_as users(:organizer)

    post manage_events_path, params: { event: { title: "", venue: "", time_zone: "Nowhere" } }

    assert_response :unprocessable_entity
    assert_select "li[data-field=time_zone]"
  end

  test "organiser publishes a draft" do
    sign_in_as users(:organizer)

    post publish_manage_event_path(events(:draft_show))

    assert events(:draft_show).reload.published?
  end

  test "publishing twice reports the error code" do
    sign_in_as users(:organizer)

    post publish_manage_event_path(events(:concert))

    assert_redirected_to manage_event_path(events(:concert))
    assert_equal "event_not_draft", flash[:error_code]
  end

  test "deleting is limited to drafts" do
    sign_in_as users(:organizer)

    assert_difference -> { Event.count }, -1 do
      delete manage_event_path(events(:draft_show))
    end

    assert_no_difference -> { Event.count } do
      delete manage_event_path(events(:concert))
    end
    assert_equal "event_not_draft", flash[:error_code]
  end

  test "organisers only see their own events" do
    sign_in_as users(:organizer)

    get manage_events_path

    assert_response :success
    assert_select "a", text: events(:concert).title
    assert_select "a", text: events(:rival_festival).title, count: 0
  end

  test "updating changes the stored instants" do
    sign_in_as users(:organizer)

    patch manage_event_path(events(:concert)), params: { event: { ends_at_local: "2030-06-01T23:59" } }

    assert_equal Time.utc(2030, 6, 2, 3, 59), events(:concert).reload.ends_at
  end
end
