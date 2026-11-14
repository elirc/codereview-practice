module Pricing
  # Prices a hold with a set of promo codes. Pure: it reads only the hold's
  # quantity and stored unit price and each code's discount settings, and does
  # not check whether the codes are valid.
  class Quote
    Line = Data.define(:promo_code, :amount_cents)
    Result = Data.define(:subtotal_cents, :lines, :discount_cents, :total_cents)

    def self.call(hold, promo_codes)
      subtotal = hold.unit_price_cents * hold.quantity
      remaining = subtotal

      lines = in_application_order(promo_codes).map do |code|
        amount = [ discount_for(code, subtotal), remaining ].min
        remaining -= amount
        Line.new(promo_code: code, amount_cents: amount)
      end

      Result.new(subtotal_cents: subtotal, lines:, discount_cents: subtotal - remaining, total_cents: remaining)
    end

    def self.in_application_order(promo_codes)
      promo_codes.sort_by { |code| [ code.percent? ? 0 : 1, code.code.to_s ] }
    end

    def self.discount_for(code, subtotal)
      if code.percent?
        (subtotal * code.percent_off + 50) / 100
      else
        code.amount_off_cents
      end
    end

    private_class_method :in_application_order, :discount_for
  end
end
