module Events
  # Cancels an event: stops sales, releases every active hold, closes open
  # waitlist entries and refunds paid orders one at a time. Running it again
  # continues with whatever is left.
  class Cancel
    BATCH_SIZE = 50

    # Marks the event cancelled straight away and leaves the rest to
    # CancelEventJob.
    def self.request(event)
      ApplicationRecord.transaction do
        event.lock!
        event.update!(status: :cancelled) unless event.cancelled?
      end
      CancelEventJob.perform_after_commit(event.id)
    end

    def self.call(...)
      new(...).call
    end

    def initialize(event, gateway: PaymentGateway.current, now: Time.current)
      @event = event
      @gateway = gateway
      @now = now
    end

    def call
      mark_cancelled
      release_holds_and_close_waitlists
      refund_paid_orders
    end

    private
      def mark_cancelled
        @event.with_lock do
          @event.update!(status: :cancelled) unless @event.cancelled?
        end
      end

      def release_holds_and_close_waitlists
        @event.ticket_tiers.reorder(:id).pluck(:id).each do |tier_id|
          ApplicationRecord.transaction do
            tier = TicketTier.lock.find(tier_id)
            Hold.active.where(ticket_tier_id: tier_id).order(:id).lock.each do |hold|
              Holds::Closing.close!(hold, tier, status: :released, entry_status: :cancelled)
            end
            tier.waitlist_entries.pending.update_all(status: "cancelled", updated_at: @now)
          end
        end
      end

      def refund_paid_orders
        @event.orders.paid.find_each(batch_size: BATCH_SIZE) do |order|
          Orders::Refund.call(order, gateway: @gateway, now: @now, notification: :event_cancelled)
        rescue DomainError => e
          raise unless e.code == :already_refunded
        end
      end
  end
end
