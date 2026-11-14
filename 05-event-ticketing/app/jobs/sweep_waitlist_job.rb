class SweepWaitlistJob < ApplicationJob
  queue_as :default

  def perform
    tier_ids = TicketTier
      .where(id: WaitlistEntry.waiting.select(:ticket_tier_id))
      .where("capacity - sold_count - held_count > 0")
      .pluck(:id)

    tier_ids.each { |tier_id| PromoteWaitlistJob.perform_later(tier_id) }
  end
end
