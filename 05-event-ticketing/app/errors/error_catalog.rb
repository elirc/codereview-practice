# Stable error codes with their HTTP status and default human message.
module ErrorCatalog
  ENTRIES = {
    validation_failed: [ 400, "The request is invalid." ],
    unauthenticated: [ 401, "You need to sign in first." ],
    forbidden: [ 403, "You are not allowed to do that." ],
    not_found: [ 404, "We couldn't find that." ],
    rate_limited: [ 429, "Too many requests. Try again later." ],
    internal_error: [ 500, "Something went wrong on our side." ]
  }.freeze

  def self.status_for(code)
    entry(code).first
  end

  def self.message_for(code)
    entry(code).last
  end

  def self.entry(code)
    ENTRIES.fetch(code.to_sym) { raise ArgumentError, "unknown error code #{code.inspect}" }
  end
end
