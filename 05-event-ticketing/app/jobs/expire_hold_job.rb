class ExpireHoldJob < ApplicationJob
  queue_as :default

  retry_on ActiveRecord::Deadlocked, ActiveRecord::LockWaitTimeout, wait: :polynomially_longer, attempts: 5
  discard_on ActiveRecord::RecordNotFound

  def perform(hold_id)
    Holds::Expire.call(Hold.find(hold_id))
  end
end
