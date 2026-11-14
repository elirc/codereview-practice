module Holds
  # Ends an active hold and returns its tickets to the tier. Callers must
  # already hold the tier lock and the hold lock.
  module Closing
    def self.close!(hold, tier, status:)
      hold.update!(status:)
      tier.adjust_counts!(held: -hold.quantity)
    end
  end
end
