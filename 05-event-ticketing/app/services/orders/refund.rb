module Orders
  # Fully refunds a paid order: voids its tickets, returns them to their
  # tiers and refunds the payment. Promo redemptions are kept.
  class Refund
    def self.call(...)
      new(...).call
    end

    def initialize(order, gateway: PaymentGateway.current, now: Time.current, notification: :refunded)
      @order = order
      @gateway = gateway
      @now = now
      @notification = notification
    end

    def call
      tier_ids = @order.tickets.distinct.pluck(:ticket_tier_id)

      ApplicationRecord.transaction do
        tiers = TicketTier.where(id: tier_ids).order(:id).lock.to_a
        @order.lock!
        raise DomainError.new(:already_refunded) unless @order.paid?

        valid_counts = @order.tickets.status_valid.group(:ticket_tier_id).count
        @order.update!(status: :refunded, refunded_at: @now)
        @order.tickets.status_valid.update_all(status: "void", updated_at: @now)
        tiers.each { |tier| tier.adjust_counts!(sold: -valid_counts.fetch(tier.id, 0)) }
        refund_payment
      end

      ActiveRecord.after_all_transactions_commit do
        tier_ids.each { |tier_id| PromoteWaitlistJob.perform_later(tier_id) }
        OrderMailer.public_send(@notification, @order).deliver_later
      end
      @order
    end

    private
      def refund_payment
        return if @order.payment_reference.blank?

        result = @gateway.refund(@order.payment_reference, amount_cents: @order.total_cents)
        raise DomainError.new(:refund_failed) unless result.approved?
      end
  end
end
