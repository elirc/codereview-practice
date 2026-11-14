module Holds
  # Expires a hold whose time is up. Returns false, changing nothing, when the
  # hold is no longer active or has not reached its expiry yet.
  class Expire
    def self.call(...)
      new(...).call
    end

    def initialize(hold, now: Time.current)
      @hold = hold
      @now = now
    end

    def call
      ApplicationRecord.transaction do
        tier = TicketTier.lock.find(@hold.ticket_tier_id)
        @hold.lock!
        next false unless @hold.active? && @hold.expires_at <= @now

        Closing.close!(@hold, tier, status: :expired)
        true
      end
    end
  end
end
