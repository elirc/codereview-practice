class SweepExpiredHoldsJob < ApplicationJob
  queue_as :default

  BATCH_SIZE = 100

  def perform
    now = Time.current

    Hold.active.where(expires_at: ..now).find_in_batches(batch_size: BATCH_SIZE) do |holds|
      holds.group_by(&:ticket_tier_id).each do |tier_id, tier_holds|
        Holds::ExpireBatch.call(tier_id, tier_holds, now:)
      rescue StandardError => e
        Rails.logger.error(
          {
            event: "holds.sweep_failed", ticket_tier_id: tier_id, hold_ids: tier_holds.map(&:id),
            error: e.class.name, message: e.message
          }
        )
      end
    end
  end
end
