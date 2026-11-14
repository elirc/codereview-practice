# Makes the request id assigned by ActionDispatch::RequestId available to the
# log formatter for the duration of the request.
class RequestLogContext
  def initialize(app)
    @app = app
  end

  def call(env)
    ActiveSupport::IsolatedExecutionState[:request_id] = env["action_dispatch.request_id"]
    @app.call(env)
  ensure
    ActiveSupport::IsolatedExecutionState.delete(:request_id)
  end
end
