# Maps exceptions to responses. JSON requests get the error envelope; HTML
# requests are redirected back with a flash carrying the same error code, or
# shown an error page for 403/404.
module ErrorHandling
  extend ActiveSupport::Concern

  included do
    rescue_from DomainError, with: :respond_with_error
    rescue_from ActiveRecord::RecordNotFound, with: :handle_not_found
    rescue_from ActionController::ParameterMissing, with: :handle_parameter_missing
  end

  private
    def handle_not_found(_exception)
      respond_with_error(DomainError.new(:not_found))
    end

    def handle_parameter_missing(exception)
      respond_with_error(DomainError.validation([ { path: exception.param.to_s, message: "is required" } ]))
    end

    def respond_with_error(error)
      if request.format.json?
        render json: ErrorEnvelope.build(error, request_id: request.request_id), status: error.status
      elsif [ 403, 404 ].include?(error.status)
        render "errors/show", locals: { error: }, status: error.status
      else
        redirect_back_or_to error_fallback_location,
          alert: error.message, flash: { error_code: error.code.to_s }, status: :see_other
      end
    end

    def error_fallback_location
      root_path
    end

    def integer_param(key, source = params)
      value = Integer(source.require(key).to_s, 10, exception: false)
      raise DomainError.validation([ { path: key.to_s, message: "must be a whole number" } ]) if value.nil?

      value
    end
end
