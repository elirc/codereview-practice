require "test_helper"

class JsonLogFormatterTest < ActiveSupport::TestCase
  setup do
    @formatter = JsonLogFormatter.new
    @time = Time.utc(2030, 5, 1, 12, 0, 0)
  end

  teardown do
    ActiveSupport::IsolatedExecutionState.delete(:request_id)
  end

  test "merges hash messages and includes the current request id" do
    ActiveSupport::IsolatedExecutionState[:request_id] = "req-123"

    line = @formatter.call("INFO", @time, nil, { event: "job.started", job_id: "abc" })
    entry = JSON.parse(line)

    assert_equal "INFO", entry["level"]
    assert_equal "2030-05-01T12:00:00.000Z", entry["time"]
    assert_equal "req-123", entry["request_id"]
    assert_equal "job.started", entry["event"]
    assert_equal "abc", entry["job_id"]
  end

  test "wraps plain strings" do
    entry = JSON.parse(@formatter.call("WARN", @time, nil, "  Started GET /  "))

    assert_equal "Started GET /", entry["message"]
    assert_not entry.key?("request_id")
  end
end
