module SessionTestHelper
  PASSWORD = "password123".freeze

  def sign_in_as(user)
    post session_path, params: { email_address: user.email_address, password: PASSWORD }
    assert_response :redirect
  end

  def sign_out
    delete session_path
  end
end

ActiveSupport.on_load(:action_dispatch_integration_test) do
  include SessionTestHelper
end
