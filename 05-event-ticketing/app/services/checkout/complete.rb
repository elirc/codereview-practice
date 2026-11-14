module Checkout
  # Turns a live hold into a paid order with tickets. Submitting again for a
  # hold that has already been converted returns the existing order.
  class Complete
    def self.call(...)
      new(...).call
    end

    def initialize(hold:, user:, payment_token:, gateway: PaymentGateway.current, now: Time.current,
                   token_generator: TokenGenerator)
      @hold = hold
      @user = user
      @payment_token = payment_token
      @gateway = gateway
      @now = now
      @token_generator = token_generator
      @replayed = false
    end

    def call
      charge = nil
      committed = false

      order = ApplicationRecord.transaction do
        tier = TicketTier.lock.find(@hold.ticket_tier_id)
        @hold.lock!
        if @hold.converted? && @hold.user_id == @user.id
          @replayed = true
          next @hold.order
        end

        verify_hold!(tier)
        amounts = { subtotal_cents: @hold.subtotal_cents, discount_cents: 0, total_cents: @hold.subtotal_cents }
        charge = collect_payment(amounts[:total_cents])

        tier.adjust_counts!(held: -@hold.quantity, sold: @hold.quantity)
        order = create_order(tier, amounts, charge)
        @hold.update!(status: :converted, order:)
        order
      end
      committed = true

      unless @replayed
        ActiveRecord.after_all_transactions_commit { OrderMailer.confirmation(order).deliver_later }
      end
      order
    rescue StandardError
      @gateway.void(charge.reference) if charge&.approved? && !committed
      raise
    end

    private
      def verify_hold!(tier)
        raise DomainError.new(:hold_expired) unless @hold.user_id == @user.id && @hold.live?(@now)
        raise DomainError.new(:event_cancelled) if tier.event.cancelled?
      end

      def collect_payment(total_cents)
        return nil unless total_cents.positive?

        charge = @gateway.charge(amount_cents: total_cents, token: @payment_token, idempotency_key: "hold-#{@hold.id}")
        raise DomainError.new(:payment_declined) unless charge.approved?

        charge
      end

      def create_order(tier, amounts, charge)
        order = Order.create!(
          user: @user,
          event_id: tier.event_id,
          number: "ORD-#{@token_generator.call(8)}",
          status: :paid,
          payment_reference: charge&.reference,
          **amounts
        )
        @hold.quantity.times do
          order.tickets.create!(ticket_tier: tier, code: @token_generator.call(12), status: :valid)
        end
        order
      end
  end
end
