require "test_helper"

class UserTest < ActiveSupport::TestCase
  test "normalises the email address" do
    user = User.create!(name: "Pat", email_address: "  Pat@Example.COM ", password: "longenough")

    assert_equal "pat@example.com", user.email_address
    assert_equal user, User.find_by(email_address: "PAT@example.com")
  end

  test "new users are customers" do
    user = User.new(name: "Pat", email_address: "pat@example.com", password: "longenough")

    assert user.customer?
    assert_not user.manager?
  end

  test "rejects unknown roles" do
    user = users(:customer)
    user.role = "superuser"

    assert_not user.valid?
    assert_includes user.errors[:role], "is not included in the list"
  end

  test "email addresses are unique regardless of case" do
    duplicate = User.new(name: "Copy", email_address: users(:customer).email_address.upcase, password: "longenough")

    assert_not duplicate.valid?
  end

  test "organizers and admins are managers" do
    assert users(:organizer).manager?
    assert users(:admin).manager?
  end
end
