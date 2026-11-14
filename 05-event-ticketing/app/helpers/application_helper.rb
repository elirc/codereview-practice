module ApplicationHelper
  # Formats integer cents as US dollars without going through floats.
  def format_cents(cents)
    sign = cents.negative? ? "-" : ""
    whole, fraction = cents.abs.divmod(100)
    "#{sign}$#{number_with_delimiter(whole)}.#{fraction.to_s.rjust(2, "0")}"
  end

  def promo_discount_label(promo_code)
    promo_code.percent? ? "#{promo_code.percent_off}% off" : "#{format_cents(promo_code.amount_off_cents)} off"
  end

  def tier_state_label(availability)
    case availability.state
    when :available then "#{availability.available} available"
    when :sold_out then "Sold out"
    when :waitlist then "Waitlist"
    else "Sales closed"
    end
  end

  def format_in_zone(time, zone)
    return "" if time.nil?

    time.in_time_zone(zone).strftime("%a %-d %b %Y, %H:%M %Z")
  end
end
