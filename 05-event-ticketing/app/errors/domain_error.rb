# Raised by services and models when an operation breaks a business rule.
# The code must be one of ErrorCatalog::ENTRIES; the status and default
# message come from there.
class DomainError < StandardError
  attr_reader :code, :details

  def initialize(code, message = nil, details: {})
    @code = code.to_sym
    @details = details
    super(message || ErrorCatalog.message_for(@code))
  end

  def status
    ErrorCatalog.status_for(code)
  end

  def self.validation(fields)
    new(:validation_failed, details: { fields: })
  end
end
