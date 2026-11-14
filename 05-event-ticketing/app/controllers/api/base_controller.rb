module Api
  # JSON endpoints. Every failure, expected or not, is answered with the
  # error envelope.
  class BaseController < ActionController::Base
    # Declared before ErrorHandling so its more specific handlers win.
    rescue_from StandardError, with: :handle_unexpected_error
    include ErrorHandling

    skip_forgery_protection

    before_action { request.format = :json }
  end
end
