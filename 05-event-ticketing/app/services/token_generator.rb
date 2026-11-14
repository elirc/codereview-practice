# Random identifiers drawn from the RFC 4648 base32 alphabet.
module TokenGenerator
  ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".freeze

  def self.call(length)
    Array.new(length) { ALPHABET[SecureRandom.random_number(ALPHABET.length)] }.join
  end
end
