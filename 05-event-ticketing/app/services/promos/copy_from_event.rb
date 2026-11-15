module Promos
  # Copies one event's promo codes onto another and returns the new codes.
  # Codes the target already has are skipped. Validity windows and tier
  # restrictions stay behind, since they belong to the source event's dates
  # and tiers.
  class CopyFromEvent
    COPIED_ATTRIBUTES = %w[
      code kind percent_off amount_off_cents stackable max_redemptions per_user_limit min_subtotal_cents active
    ].freeze

    def self.call(...)
      new(...).call
    end

    def initialize(source:, target:)
      @source = source
      @target = target
    end

    def call
      taken = @target.promo_codes.pluck(:code)

      PromoCode.transaction do
        @source.promo_codes.order(:code).reject { |promo| taken.include?(promo.code) }.map do |promo|
          @target.promo_codes.create!(promo.attributes.slice(*COPIED_ATTRIBUTES))
        end
      end
    end
  end
end
