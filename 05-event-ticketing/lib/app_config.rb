# Reads every environment variable the application depends on, validates it
# once at boot, and exposes the typed values. Boot fails with a list of all
# problems when anything is missing or malformed.
module AppConfig
  class InvalidConfiguration < StandardError; end

  Settings = Data.define(
    :database_url, :db_pool, :max_threads, :port, :job_concurrency, :log_level,
    :app_host, :mail_from, :payment_gateway, :fake_gateway_mode
  )

  LOG_LEVELS = %w[ debug info warn error fatal ].freeze
  PAYMENT_GATEWAYS = %w[ fake ].freeze
  FAKE_GATEWAY_MODES = %w[ succeed decline ].freeze

  class << self
    def load!(env, rails_env)
      production = rails_env.to_s == "production"
      errors = []

      database_url = presence(env["DATABASE_URL"])
      errors << "DATABASE_URL is required in production" if production && database_url.nil?
      if production && presence(env["SECRET_KEY_BASE"]).nil?
        errors << "SECRET_KEY_BASE is required in production"
      end

      app_host = presence(env["APP_HOST"])
      errors << "APP_HOST is required in production" if production && app_host.nil?

      log_level = env.fetch("RAILS_LOG_LEVEL", production ? "info" : "debug")
      errors << "RAILS_LOG_LEVEL must be one of #{LOG_LEVELS.join(", ")}" unless LOG_LEVELS.include?(log_level)

      payment_gateway = env.fetch("PAYMENT_GATEWAY", "fake")
      unless PAYMENT_GATEWAYS.include?(payment_gateway)
        errors << "PAYMENT_GATEWAY must be one of #{PAYMENT_GATEWAYS.join(", ")}"
      end

      fake_gateway_mode = env.fetch("FAKE_GATEWAY_MODE", "succeed")
      unless FAKE_GATEWAY_MODES.include?(fake_gateway_mode)
        errors << "FAKE_GATEWAY_MODE must be one of #{FAKE_GATEWAY_MODES.join(", ")}"
      end

      db_pool = positive_integer(env, "DB_POOL", 15, errors)
      max_threads = positive_integer(env, "RAILS_MAX_THREADS", 3, errors)
      port = positive_integer(env, "PORT", 3000, errors)
      job_concurrency = positive_integer(env, "JOB_CONCURRENCY", 1, errors)

      raise InvalidConfiguration, "Invalid configuration: #{errors.join("; ")}" if errors.any?

      @settings = Settings.new(
        database_url:, db_pool:, max_threads:, port:, job_concurrency:,
        log_level: log_level.to_sym,
        app_host: app_host || "localhost:3000",
        mail_from: env.fetch("MAIL_FROM", "tickets@example.com"),
        payment_gateway:,
        fake_gateway_mode: fake_gateway_mode.to_sym
      )
    end

    def settings
      @settings || raise(InvalidConfiguration, "AppConfig.load! has not been called")
    end

    Settings.members.each do |name|
      define_method(name) { settings.public_send(name) }
    end

    private
      def presence(value)
        value.nil? || value.strip.empty? ? nil : value
      end

      def positive_integer(env, key, default, errors)
        raw = env.fetch(key, default.to_s)
        value = Integer(raw, 10, exception: false)
        if value.nil? || value <= 0
          errors << "#{key} must be a positive integer"
          return default
        end
        value
      end
  end
end
