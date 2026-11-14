class SweepExpiredHoldsJob < ApplicationJob
  queue_as :default

  BATCH_SIZE = 100

  def perform
    now = Time.current

    Hold.active.where(expires_at: ..now).find_each(batch_size: BATCH_SIZE) do |hold|
      Holds::Expire.call(hold, now:)
    rescue StandardError => e
      Rails.logger.error(
        { event: "holds.sweep_failed", hold_id: hold.id, error: e.class.name, message: e.message }
      )
    end
  end
end
