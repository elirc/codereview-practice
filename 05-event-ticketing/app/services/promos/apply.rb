module Promos
  # Validates a promo code and attaches it to a hold.
  class Apply
    def self.call(...)
      new(...).call
    end

    def initialize(hold:, user:, code:, now: Time.current)
      @hold = hold
      @user = user
      @code = code
      @now = now
    end

    def call
      ApplicationRecord.transaction do
        @hold.lock!
        raise DomainError.new(:hold_expired) unless @hold.user_id == @user.id && @hold.live?(@now)

        promo = PromoCode.lookup(@code, @hold.ticket_tier.event)
        raise DomainError.new(:promo_not_found) if promo.nil?

        error = Validation.new(hold: @hold, user: @user, now: @now).error_for(promo) ||
          Validation.stacking_error(@hold.promo_codes.to_a + [ promo ])
        raise DomainError.new(error, details: { promo_code: promo.code }) if error

        @hold.hold_promos.create!(promo_code: promo)
        promo
      end
    end
  end
end
