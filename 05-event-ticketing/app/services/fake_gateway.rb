# In-process payment gateway for development and tests. It approves every
# charge unless it is in :decline mode or the token is DECLINE_TOKEN, honours
# idempotency keys for approved charges, and records every call.
class FakeGateway
  DECLINE_TOKEN = "tok_decline".freeze

  attr_accessor :mode
  attr_reader :charges, :voids, :refunds

  def initialize(mode: :succeed)
    @mode = mode.to_sym
    @mutex = Mutex.new
    @sequence = 0
    @approved_by_key = {}
    @charges = []
    @voids = []
    @refunds = []
  end

  def charge(amount_cents:, token:, idempotency_key:)
    @mutex.synchronize do
      @approved_by_key.fetch(idempotency_key) do
        next PaymentGateway::Result.new(status: :declined, reference: nil, message: "Card declined") if declines?(token)

        @sequence += 1
        reference = "fake_ch_#{@sequence}"
        @charges << { amount_cents:, idempotency_key:, reference: }
        @approved_by_key[idempotency_key] = PaymentGateway::Result.new(status: :approved, reference:, message: nil)
      end
    end
  end

  def void(reference)
    @mutex.synchronize do
      @voids << reference
      @approved_by_key.delete_if { |_key, result| result.reference == reference }
      PaymentGateway::Result.new(status: :approved, reference:, message: nil)
    end
  end

  def refund(reference, amount_cents:)
    @mutex.synchronize do
      @refunds << { reference:, amount_cents: }
      PaymentGateway::Result.new(status: :approved, reference:, message: nil)
    end
  end

  private
    def declines?(token)
      mode == :decline || token == DECLINE_TOKEN
    end
end
