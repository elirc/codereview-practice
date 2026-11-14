class PromoteWaitlistJob < ApplicationJob
  queue_as :default

  retry_on ActiveRecord::Deadlocked, ActiveRecord::LockWaitTimeout, wait: :polynomially_longer, attempts: 5
  discard_on ActiveRecord::RecordNotFound

  def perform(tier_id)
    Waitlist::Promote.call(TicketTier.find(tier_id))
  end
end
