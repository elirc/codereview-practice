require "test_helper"

class RegistrationsControllerTest < ActionDispatch::IntegrationTest
  test "signs up a customer and starts a session" do
    assert_difference -> { User.count }, 1 do
      post registration_path, params: {
        user: { name: "New Person", email_address: "new@example.com", password: "s3cret-pass", password_confirmation: "s3cret-pass" }
      }
    end

    user = User.find_by!(email_address: "new@example.com")
    assert user.customer?
    assert cookies[:session_id].present?
  end

  test "ignores a role submitted with the form" do
    post registration_path, params: {
      user: { name: "Sneaky", email_address: "sneaky@example.com", password: "s3cret-pass",
              password_confirmation: "s3cret-pass", role: "admin" }
    }

    assert User.find_by!(email_address: "sneaky@example.com").customer?
  end

  test "re-renders with field errors" do
    post registration_path, params: {
      user: { name: "", email_address: "bad", password: "short", password_confirmation: "other" }
    }

    assert_response :unprocessable_entity
    assert_select ".form-errors[data-error-code=validation_failed]"
    assert_select "li[data-field=email_address]"
  end
end
