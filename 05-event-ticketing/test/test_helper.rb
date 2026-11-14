ENV["RAILS_ENV"] ||= "test"
require_relative "../config/environment"
require "rails/test_help"

module ActiveSupport
  class TestCase
    include ActiveSupport::Testing::TimeHelpers

    fixtures :all
  end
end

Dir[File.expand_path("support/**/*.rb", __dir__)].sort.each { |file| require file }
