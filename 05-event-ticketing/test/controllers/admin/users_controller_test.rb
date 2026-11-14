require "test_helper"

class Admin::UsersControllerTest < ActionDispatch::IntegrationTest
  test "admins list users and change roles" do
    sign_in_as users(:admin)

    get admin_users_path
    assert_response :success

    patch admin_user_path(users(:customer)), params: { user: { role: "organizer" } }

    assert users(:customer).reload.organizer?
    assert_redirected_to admin_users_path
  end

  test "unknown roles are rejected" do
    sign_in_as users(:admin)

    patch admin_user_path(users(:customer)), params: { user: { role: "overlord" } }

    assert users(:customer).reload.customer?
    assert_equal "validation_failed", flash[:error_code]
  end

  test "organisers and customers are forbidden" do
    [ users(:organizer), users(:customer) ].each do |user|
      sign_in_as user

      get admin_users_path
      assert_response :forbidden

      patch admin_user_path(users(:other_customer)), params: { user: { role: "admin" } }
      assert_response :forbidden
    end

    assert users(:other_customer).reload.customer?
  end
end
