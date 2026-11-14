require "test_helper"

class ErrorEnvelopeTest < ActiveSupport::TestCase
  test "builds the envelope with code, message, details and request id" do
    error = DomainError.validation([ { path: "quantity", message: "is required" } ])

    body = ErrorEnvelope.build(error, request_id: "req-1")

    assert_equal "validation_failed", body[:error][:code]
    assert_equal "The request is invalid.", body[:error][:message]
    assert_equal "req-1", body[:error][:request_id]
    assert_equal [ { path: "quantity", message: "is required" } ], body[:error][:details][:fields]
    assert_equal 400, error.status
  end

  test "omits empty details" do
    body = ErrorEnvelope.build(DomainError.new(:not_found), request_id: "req-2")

    assert_not body[:error].key?(:details)
  end

  test "unknown codes are rejected" do
    assert_raises(ArgumentError) { DomainError.new(:made_up) }
  end
end
