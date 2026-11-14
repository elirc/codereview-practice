# The test environment is used exclusively to run your application's
# test suite. You never need to work with it otherwise.

Rails.application.configure do
  # Settings specified here will take precedence over those in config/application.rb.

  config.enable_reloading = false

  # Eager loading in CI catches files that fail to load before any test touches them.
  config.eager_load = ENV["CI"].present?

  config.public_file_server.headers = { "cache-control" => "public, max-age=3600" }

  config.consider_all_requests_local = true
  config.cache_store = :null_store

  config.action_dispatch.show_exceptions = :rescuable
  config.action_controller.allow_forgery_protection = false

  config.logger = ActiveSupport::Logger.new(config.root.join("log", "test.log")).tap do |logger|
    logger.formatter = JsonLogFormatter.new
  end
  config.log_level = :debug

  config.action_mailer.delivery_method = :test
  config.action_mailer.default_url_options = { host: "example.com" }

  config.active_job.queue_adapter = :test

  config.active_support.deprecation = :stderr
  config.action_controller.raise_on_missing_callback_actions = true
end
