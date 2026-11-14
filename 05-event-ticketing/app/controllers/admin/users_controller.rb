module Admin
  class UsersController < ApplicationController
    before_action :require_admin

    def index
      @users = User.order(:created_at)
    end

    def update
      user = User.find(params[:id])

      if user.update(params.require(:user).permit(:role))
        redirect_to admin_users_path, notice: "#{user.name} is now #{user.role}."
      else
        redirect_to admin_users_path, alert: user.errors.full_messages.to_sentence,
          flash: { error_code: "validation_failed" }
      end
    end

    private
      def require_admin
        authorize!(UserPolicy.new(current_user, User).manage?)
      end
  end
end
