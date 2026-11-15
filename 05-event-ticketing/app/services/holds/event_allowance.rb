module Holds
  # Caps how many tickets one user may hold or own for a single event.
  module EventAllowance
    LIMIT = 8

    # How many more tickets the user may hold or wait for at the event.
    def self.remaining(user:, event:, now:)
      [ LIMIT - committed(user, event.id, now), 0 ].max
    end

    # Raises event_limit_exceeded unless the user may take quantity more
    # tickets on tier. The user's own hold on the tier is not counted, since a
    # new hold there replaces it.
    def self.check!(user:, tier:, quantity:, now:)
      committed = committed(user, tier.event_id, now, except_tier_id: tier.id)
      return if committed + quantity <= LIMIT

      raise DomainError.new(:event_limit_exceeded, details: { limit: LIMIT, remaining: [ LIMIT - committed, 0 ].max })
    end

    def self.committed(user, event_id, now, except_tier_id: nil)
      paid_ticket_count(user, event_id) + live_hold_quantity(user, event_id, now, except_tier_id) +
        waiting_quantity(user, event_id)
    end

    def self.paid_ticket_count(user, event_id)
      Ticket.status_valid.joins(:order).where(orders: { user_id: user.id, event_id:, status: "paid" }).count
    end

    def self.waiting_quantity(user, event_id)
      WaitlistEntry.waiting.joins(:ticket_tier)
        .where(user_id: user.id, ticket_tiers: { event_id: })
        .sum(:quantity)
    end

    def self.live_hold_quantity(user, event_id, now, except_tier_id)
      holds = Hold.live(now).joins(:ticket_tier).where(user_id: user.id, ticket_tiers: { event_id: })
      holds = holds.where.not(ticket_tier_id: except_tier_id) if except_tier_id
      holds.sum(:quantity)
    end
  end
end
