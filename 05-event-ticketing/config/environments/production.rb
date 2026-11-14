require "active_support/core_ext/integer/time"

Rails.application.configure do
  # Settings specified here will take precedence over those in config/application.rb.

  config.enable_reloading = false
  config.eager_load = true
  config.consider_all_requests_local = false

  config.action_controller.perform_caching = true
  config.public_file_server.headers = { "cache-control" => "public, max-age=#{1.year.to_i}" }

  config.assume_ssl = true
  config.force_ssl = true
  config.ssl_options = { redirect: { exclude: ->(request) { request.path == "/up" } } }

  config.logger = ActiveSupport::Logger.new($stdout).tap { |logger| logger.formatter = JsonLogFormatter.new }
  config.log_level = AppConfig.log_level

  config.active_support.report_deprecations = false

  # A single-process store is enough for the sign-in rate limiter.
  config.cache_store = :memory_store

  # No mail provider is configured; letters are written to the log.
  config.action_mailer.delivery_method = :log
  config.action_mailer.default_url_options = { host: AppConfig.app_host, protocol: "https" }

  config.i18n.fallbacks = true

  config.active_record.dump_schema_after_migration = false
  config.active_record.attributes_for_inspect = [ :id ]
end
