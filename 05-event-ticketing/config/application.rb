require_relative "boot"

require "rails"
require "active_model/railtie"
require "active_job/railtie"
require "active_record/railtie"
require "action_controller/railtie"
require "action_mailer/railtie"
require "action_view/railtie"
require "action_cable/engine"
require "rails/test_unit/railtie"

# Require the gems listed in Gemfile, including any gems
# you've limited to :test, :development, or :production.
Bundler.require(*Rails.groups)

require_relative "../lib/app_config"
require_relative "../lib/json_log_formatter"
require_relative "../lib/request_log_context"

AppConfig.load!(ENV, Rails.env)

module EventTicketing
  class Application < Rails::Application
    config.load_defaults 8.0

    config.time_zone = "UTC"
    config.active_record.default_timezone = :utc

    config.active_job.queue_adapter = :solid_queue

    config.colorize_logging = false
    config.log_tags = []
    config.middleware.insert_after ActionDispatch::RequestId, RequestLogContext

    config.action_mailer.default_url_options = { host: AppConfig.app_host }

    config.generators do |g|
      g.orm :active_record, primary_key_type: :uuid
    end
  end
end
