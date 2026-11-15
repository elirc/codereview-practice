module Holds
  # Expires holds on one tier that the sweep found past their time, in one
  # transaction, and schedules promotion for the tier once. Returns the
  # number of holds expired.
  class ExpireBatch
    def self.call(...)
      new(...).call
    end

    def initialize(tier_id, holds, now: Time.current)
      @tier_id = tier_id
      @holds = holds
      @now = now
    end

    def call
      ApplicationRecord.transaction do
        tier = TicketTier.lock.find(@tier_id)
        Hold.where(id: @holds.map(&:id)).update_all(status: "expired", updated_at: @now)
        WaitlistEntry.offered.where(id: @holds.filter_map(&:waitlist_entry_id))
          .update_all(status: "expired", updated_at: @now)
        tier.adjust_counts!(held: -@holds.sum(&:quantity))
      end

      PromoteWaitlistJob.perform_after_commit(@tier_id)
      @holds.size
    end
  end
end
