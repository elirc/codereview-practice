require "test_helper"

class EventPolicyTest < ActiveSupport::TestCase
  test "drafts are visible only to their organiser and admins" do
    draft = events(:draft_show)

    assert EventPolicy.new(users(:organizer), draft).show?
    assert EventPolicy.new(users(:admin), draft).show?
    assert_not EventPolicy.new(users(:other_organizer), draft).show?
    assert_not EventPolicy.new(users(:customer), draft).show?
    assert_not EventPolicy.new(nil, draft).show?
  end

  test "visible scope hides other people's drafts" do
    assert_not_includes EventPolicy.visible_scope(nil), events(:draft_show)
    assert_not_includes EventPolicy.visible_scope(users(:other_organizer)), events(:draft_show)
    assert_includes EventPolicy.visible_scope(users(:organizer)), events(:draft_show)
    assert_includes EventPolicy.visible_scope(nil), events(:rival_festival)
  end

  test "organisers manage only their own events" do
    assert EventPolicy.new(users(:organizer), events(:concert)).manage?
    assert_not EventPolicy.new(users(:organizer), events(:rival_festival)).manage?
    assert EventPolicy.new(users(:admin), events(:rival_festival)).manage?
    assert_not EventPolicy.new(users(:customer), events(:concert)).manage?
  end

  test "manageable scope" do
    assert_equal [ events(:rival_festival) ], EventPolicy.manageable_scope(users(:other_organizer)).to_a
    assert_equal Event.count, EventPolicy.manageable_scope(users(:admin)).count
    assert_empty EventPolicy.manageable_scope(users(:customer))
  end
end
