module Holds
  # Ends an active hold and returns its tickets to the tier. When the hold was
  # a waitlist offer, its entry is closed with entry_status. Callers must
  # already hold the tier lock and the hold lock.
  module Closing
    def self.close!(hold, tier, status:, entry_status: :expired)
      hold.update!(status:)
      tier.adjust_counts!(held: -hold.quantity)

      entry = hold.waitlist_entry
      entry.update!(status: entry_status) if entry&.offered?
    end
  end
end
