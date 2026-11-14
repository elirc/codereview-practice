# Base for the plain policy objects controllers consult before acting.
# Policies answer questions about one user and one record; scoping helpers
# live as class methods on the concrete policy.
class ApplicationPolicy
  attr_reader :user, :record

  def initialize(user, record)
    @user = user
    @record = record
  end

  private
    def signed_in?
      user.present?
    end

    def admin?
      user&.admin? || false
    end
end
