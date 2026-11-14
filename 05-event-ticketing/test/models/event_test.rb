require "test_helper"

class EventTest < ActiveSupport::TestCase
  def build_event(**attributes)
    Event.new({
      organizer: users(:organizer), title: "Gig", venue: "Hall", time_zone: "America/New_York",
      starts_at_local: "2030-06-01T19:00", ends_at_local: "2030-06-01T22:00"
    }.merge(attributes))
  end

  test "local times are interpreted in the event time zone" do
    event = build_event
    event.save!

    assert_equal Time.utc(2030, 6, 1, 23, 0), event.starts_at
    assert_equal Time.utc(2030, 6, 2, 2, 0), event.ends_at
    assert_equal "2030-06-01T19:00", event.reload.starts_at_local
  end

  test "zone can be assigned after the local times" do
    event = Event.new(organizer: users(:organizer), title: "Gig", venue: "Hall",
      starts_at_local: "2030-01-10T09:30", ends_at_local: "2030-01-10T11:00")
    event.time_zone = "Asia/Tokyo"
    event.save!

    assert_equal Time.utc(2030, 1, 10, 0, 30), event.starts_at
  end

  test "sales close at the start time by default" do
    event = build_event
    event.save!

    assert_equal event.starts_at, event.sales_close_at
  end

  test "an explicit sales close time is kept" do
    event = build_event(sales_close_at_local: "2030-06-01T12:00")
    event.save!

    assert_equal Time.utc(2030, 6, 1, 16, 0), event.sales_close_at
  end

  test "rejects unknown time zones and unparseable times" do
    event = build_event(time_zone: "Mars/Olympus")
    assert_not event.valid?
    assert event.errors.of_kind?(:time_zone, :inclusion)

    event = build_event(starts_at_local: "not a date")
    assert_not event.valid?
    assert_includes event.errors[:starts_at], "is not a valid date and time"
  end

  test "ends must come after starts" do
    event = build_event(ends_at_local: "2030-06-01T18:00")

    assert_not event.valid?
    assert_includes event.errors[:ends_at], "must be after the start"
  end

  test "on sale only while published and before sales close" do
    event = events(:concert)

    assert event.on_sale?(event.sales_close_at - 1.second)
    assert_not event.on_sale?(event.sales_close_at)
    assert_not events(:draft_show).on_sale?(Time.utc(2030, 5, 1))
  end

  test "publishing a non-draft is refused" do
    error = assert_raises(DomainError) { events(:concert).publish! }

    assert_equal :event_not_draft, error.code
  end
end
