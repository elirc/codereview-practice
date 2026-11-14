require "test_helper"

class AppConfigTest < ActiveSupport::TestCase
  teardown do
    AppConfig.load!(ENV, Rails.env)
  end

  test "development defaults load without any variables" do
    settings = AppConfig.load!({}, "development")

    assert_equal 15, settings.db_pool
    assert_equal "localhost:3000", settings.app_host
    assert_equal :succeed, settings.fake_gateway_mode
    assert_equal :debug, settings.log_level
  end

  test "production requires database, secret and host" do
    error = assert_raises(AppConfig::InvalidConfiguration) { AppConfig.load!({}, "production") }

    assert_includes error.message, "DATABASE_URL"
    assert_includes error.message, "SECRET_KEY_BASE"
    assert_includes error.message, "APP_HOST"
  end

  test "rejects malformed values" do
    env = { "DB_POOL" => "many", "FAKE_GATEWAY_MODE" => "maybe", "RAILS_LOG_LEVEL" => "loud" }
    error = assert_raises(AppConfig::InvalidConfiguration) { AppConfig.load!(env, "development") }

    assert_includes error.message, "DB_POOL"
    assert_includes error.message, "FAKE_GATEWAY_MODE"
    assert_includes error.message, "RAILS_LOG_LEVEL"
  end
end
