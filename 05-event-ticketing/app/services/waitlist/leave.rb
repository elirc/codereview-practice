module Waitlist
  # Takes the user off a tier's waitlist, giving back any offer they hold.
  class Leave
    def self.call(...)
      new(...).call
    end

    def initialize(entry)
      @entry = entry
    end

    def call
      ApplicationRecord.transaction do
        tier = TicketTier.lock.find(@entry.ticket_tier_id)
        hold = Hold.lock.find_by(waitlist_entry_id: @entry.id)
        @entry.lock!
        raise DomainError.new(:waitlist_entry_closed) unless @entry.open?

        if hold&.active?
          Holds::Closing.close!(hold, tier, status: :released, entry_status: :cancelled)
        else
          @entry.update!(status: :cancelled)
        end
      end

      PromoteWaitlistJob.perform_after_commit(@entry.ticket_tier_id)
      @entry
    end
  end
end
