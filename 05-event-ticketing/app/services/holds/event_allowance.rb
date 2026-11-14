module Holds
  # Caps how many tickets one user may hold or own for a single event.
  module EventAllowance
    LIMIT = 8

    def self.check!(user:, event:, quantity:, now:, excluding: nil)
      committed = live_hold_quantity(user, event, now, excluding)
      return if committed + quantity <= LIMIT

      raise DomainError.new(:event_limit_exceeded, details: { limit: LIMIT, remaining: [ LIMIT - committed, 0 ].max })
    end

    def self.live_hold_quantity(user, event, now, excluding)
      holds = Hold.live(now).joins(:ticket_tier).where(user_id: user.id, ticket_tiers: { event_id: event.id })
      holds = holds.where.not(id: excluding.id) if excluding
      holds.sum(:quantity)
    end
  end
end
