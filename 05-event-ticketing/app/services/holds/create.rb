module Holds
  # Places a time-limited hold on tickets in one tier, replacing the user's
  # existing active hold on that tier if there is one.
  class Create
    def self.call(...)
      new(...).call
    end

    def initialize(user:, tier:, quantity:, now: Time.current)
      @user = user
      @tier = tier
      @quantity = quantity
      @now = now
    end

    def call
      hold = ApplicationRecord.transaction do
        tier = TicketTier.lock.find(@tier.id)
        event = tier.event

        raise DomainError.new(:sales_closed) unless event.on_sale?(@now)
        unless @quantity.between?(1, tier.per_order_limit)
          raise DomainError.new(:quantity_invalid, details: { per_order_limit: tier.per_order_limit })
        end

        existing = Hold.active.lock.find_by(user_id: @user.id, ticket_tier_id: tier.id)
        EventAllowance.check!(user: @user, event:, quantity: @quantity, now: @now, excluding: existing)
        raise DomainError.new(:waitlist_active) if tier.waitlist_entries.pending.exists?

        replace(existing, tier)
      end

      ActiveRecord.after_all_transactions_commit do
        ExpireHoldJob.set(wait_until: hold.expires_at).perform_later(hold.id)
      end
      hold
    end

    private
      def replace(existing, tier)
        released = existing ? existing.quantity : 0
        if tier.available + released < @quantity
          raise DomainError.new(:insufficient_capacity, details: { available: tier.available })
        end

        existing&.update!(status: :released)
        tier.adjust_counts!(held: @quantity - released)

        Hold.create!(
          user: @user,
          ticket_tier: tier,
          quantity: @quantity,
          unit_price_cents: tier.price_cents,
          status: :active,
          source: :direct,
          expires_at: @now + Hold::DIRECT_TTL
        )
      end
  end
end
