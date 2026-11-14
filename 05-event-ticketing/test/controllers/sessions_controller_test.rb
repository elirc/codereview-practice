require "test_helper"

class SessionsControllerTest < ActionDispatch::IntegrationTest
  test "signs in with valid credentials and sets an http-only cookie" do
    post session_path, params: { email_address: "CASEY@example.com", password: "password123" }

    assert_redirected_to root_url
    assert cookies[:session_id].present?
    assert_match(/httponly/i, response.headers["Set-Cookie"].to_s)
    assert_match(/samesite=lax/i, response.headers["Set-Cookie"].to_s)
  end

  test "rejects a wrong password" do
    post session_path, params: { email_address: "casey@example.com", password: "nope-nope" }

    assert_redirected_to new_session_path
    assert cookies[:session_id].blank?
  end

  test "signing out destroys the session record" do
    sign_in_as users(:customer)

    assert_difference -> { Session.count }, -1 do
      delete session_path
    end
    assert_redirected_to new_session_path
  end
end
