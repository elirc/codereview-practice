module Waitlist
  # Adds the user to a tier's waitlist when the tickets they want cannot be
  # held directly.
  class Join
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
      ApplicationRecord.transaction do
        User.lock.find(@user.id)
        tier = TicketTier.lock.find(@tier.id)
        event = tier.event

        raise DomainError.new(:sales_closed) unless event.on_sale?(@now)
        unless @quantity.between?(1, tier.per_order_limit)
          raise DomainError.new(:quantity_invalid, details: { per_order_limit: tier.per_order_limit })
        end

        queue = tier.waitlist_entries.pending
        raise DomainError.new(:already_waitlisted) if queue.exists?(user_id: @user.id)
        unless tier.available < @quantity || queue.exists?
          raise DomainError.new(:tickets_available, details: { available: tier.available })
        end

        Holds::EventAllowance.check!(user: @user, event:, quantity: @quantity, now: @now)

        tier.waitlist_entries.create!(user: @user, quantity: @quantity, status: :waiting, created_at: @now)
      end
    end
  end
end
