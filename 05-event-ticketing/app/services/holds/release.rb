module Holds
  # Gives up an active hold before it expires. Returns false when the hold was
  # no longer active, in which case nothing changes.
  class Release
    def self.call(...)
      new(...).call
    end

    def initialize(hold)
      @hold = hold
    end

    def call
      closed = ApplicationRecord.transaction do
        tier = TicketTier.lock.find(@hold.ticket_tier_id)
        @hold.lock!
        next false unless @hold.active?

        Closing.close!(@hold, tier, status: :released)
        true
      end

      PromoteWaitlistJob.perform_after_commit(@hold.ticket_tier_id) if closed
      closed
    end
  end
end
