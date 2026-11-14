class ApplicationJob < ActiveJob::Base
  around_perform :log_execution

  # Enqueues once every open transaction on the current connection has
  # committed, or immediately when none is open.
  def self.perform_after_commit(*arguments)
    ActiveRecord.after_all_transactions_commit { perform_later(*arguments) }
  end

  private
    def log_execution
      started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
      Rails.logger.info(log_fields.merge(event: "job.started"))
      yield
      elapsed_ms = ((Process.clock_gettime(Process::CLOCK_MONOTONIC) - started) * 1000).round
      Rails.logger.info(log_fields.merge(event: "job.finished", duration_ms: elapsed_ms))
    rescue StandardError => e
      Rails.logger.error(log_fields.merge(event: "job.failed", error: e.class.name, message: e.message))
      raise
    end

    def log_fields
      { job: self.class.name, job_id:, attempt: executions, queue: queue_name }
    end
end
