# Builds the JSON body used for every error response.
module ErrorEnvelope
  def self.build(error, request_id:)
    body = { code: error.code.to_s, message: error.message, requestId: request_id }
    body[:details] = error.details if error.details.present?
    { error: body }
  end
end
