class CancelEventJob < ApplicationJob
  queue_as :default

  retry_on StandardError, wait: :polynomially_longer, attempts: 3
  discard_on ActiveRecord::RecordNotFound

  def perform(event_id)
    Events::Cancel.call(Event.find(event_id))
  end
end
