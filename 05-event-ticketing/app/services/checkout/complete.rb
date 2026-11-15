module Checkout
  # Turns a hold into a paid order with tickets.
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
        promo_codes = @hold.promo_codes.order(:id).to_a
        Promos::Validation.new(hold: @hold, user: @user, now: @now).verify!(promo_codes)
        quote = Pricing::Quote.call(@hold, promo_codes)
        charge = collect_payment(quote.total_cents)

        tier.adjust_counts!(held: -@hold.quantity, sold: @hold.quantity)
        order = create_order(tier, quote, charge)
        redeem(order, quote)
        @hold.update!(status: :converted, order:)
        @hold.waitlist_entry&.update!(status: :converted)
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
        raise DomainError.new(:hold_expired) unless @hold.user_id == @user.id && @hold.active?
        raise DomainError.new(:hold_expired) if @hold.past_expiry?(@now)
        raise DomainError.new(:event_cancelled) if tier.event.cancelled?
      end

      def collect_payment(total_cents)
        return nil unless total_cents.positive?

        charge = @gateway.charge(amount_cents: total_cents, token: @payment_token, idempotency_key: "hold-#{@hold.id}")
        raise DomainError.new(:payment_declined) unless charge.approved?

        charge
      end

      def create_order(tier, quote, charge)
        order = Order.create!(
          user: @user,
          event_id: tier.event_id,
          number: "ORD-#{@token_generator.call(8)}",
          status: :paid,
          subtotal_cents: quote.subtotal_cents,
          discount_cents: quote.discount_cents,
          total_cents: quote.total_cents,
          payment_reference: charge&.reference
        )
        @hold.quantity.times do
          order.tickets.create!(ticket_tier: tier, code: @token_generator.call(12), status: :valid)
        end
        order
      end

      def redeem(order, quote)
        codes = PromoCode.where(id: quote.lines.map { |line| line.promo_code.id }).order(:id).lock.index_by(&:id)

        quote.lines.each do |line|
          code = codes.fetch(line.promo_code.id)
          raise DomainError.new(:promo_exhausted, details: { promo_code: code.code }) if code.exhausted?

          order.promo_redemptions.create!(promo_code: code, user: @user, amount_cents: line.amount_cents)
          code.increment!(:redemptions_count)
        end
      end
  end
end
