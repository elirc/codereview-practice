module Promos
  # Decides whether promo codes may be used on a hold, against the counts
  # currently loaded on each code.
  class Validation
    def self.stacking_error(codes)
      return :promo_not_stackable if codes.size > PromoCode::MAX_PER_HOLD
      return :promo_not_stackable if codes.map(&:id).uniq.size < codes.size
      return if codes.size < 2
      return :promo_not_stackable unless codes.all?(&:stackable?)
      return :promo_not_stackable if codes.all?(&:percent?)

      nil
    end

    def initialize(hold:, user:, now:)
      @hold = hold
      @user = user
      @now = now
    end

    def error_for(code)
      return :promo_not_found unless code.active? && (code.site_wide? || code.event_id == event_id)
      return :promo_not_active unless code.in_window?(@now)
      return :promo_not_applicable unless code.applies_to_tier?(@hold.ticket_tier_id)
      return :promo_min_not_met if @hold.subtotal_cents < code.min_subtotal_cents
      return :promo_exhausted if code.exhausted?
      return :promo_user_limit if redemptions_by_user(code) >= code.per_user_limit

      nil
    end

    def verify!(codes)
      codes.each do |code|
        error = error_for(code)
        raise DomainError.new(error, details: { promo_code: code.code }) if error
      end

      error = self.class.stacking_error(codes)
      raise DomainError.new(error) if error
    end

    private
      def event_id
        @hold.ticket_tier.event_id
      end

      def redemptions_by_user(code)
        PromoRedemption.where(promo_code_id: code.id, user_id: @user.id).count
      end
  end
end
