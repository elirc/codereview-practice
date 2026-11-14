module Tiers
  # Edits a tier. Returns the tier; it carries validation errors when the
  # attributes were invalid.
  class Update
    def self.call(...)
      new(...).call
    end

    def initialize(tier, attributes)
      @tier = tier
      @attributes = attributes
    end

    def call
      capacity_raised = false

      tier = ApplicationRecord.transaction do
        locked = TicketTier.lock.find(@tier.id)
        previous_capacity = locked.capacity
        locked.assign_attributes(@attributes)
        next locked unless locked.valid?

        if locked.capacity < locked.committed
          raise DomainError.new(:capacity_below_committed, details: { committed: locked.committed })
        end

        locked.save!
        capacity_raised = locked.capacity > previous_capacity
        locked
      end

      PromoteWaitlistJob.perform_after_commit(tier.id) if capacity_raised
      tier
    end
  end
end
