# Payment provider boundary. An implementation responds to:
#
#   charge(amount_cents:, token:, idempotency_key:) -> Result
#   void(reference)                                 -> Result
#   refund(reference, amount_cents:)                -> Result
#
# The implementation in use is chosen by PAYMENT_GATEWAY; tests assign their
# own instance with PaymentGateway.current=.
module PaymentGateway
  Result = Data.define(:status, :reference, :message) do
    def approved?
      status == :approved
    end
  end

  class << self
    attr_writer :current

    def current
      @current ||= build(AppConfig.payment_gateway, mode: AppConfig.fake_gateway_mode)
    end

    def build(name, mode:)
      case name
      when "fake" then FakeGateway.new(mode:)
      else raise ArgumentError, "unknown payment gateway #{name.inspect}"
      end
    end
  end
end
