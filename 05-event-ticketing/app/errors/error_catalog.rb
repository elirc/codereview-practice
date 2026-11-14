# Stable error codes with their HTTP status and default human message.
module ErrorCatalog
  ENTRIES = {
    validation_failed: [ 400, "The request is invalid." ],
    unauthenticated: [ 401, "You need to sign in first." ],
    forbidden: [ 403, "You are not allowed to do that." ],
    not_found: [ 404, "We couldn't find that." ],
    rate_limited: [ 429, "Too many requests. Try again later." ],
    internal_error: [ 500, "Something went wrong on our side." ],
    event_not_draft: [ 409, "Only draft events can be changed that way." ],
    event_cancelled: [ 409, "This event has been cancelled." ],
    sales_closed: [ 422, "Ticket sales for this event are closed." ],
    quantity_invalid: [ 422, "That ticket quantity is not allowed for this tier." ],
    event_limit_exceeded: [ 422, "You can hold or buy at most 8 tickets for one event." ],
    insufficient_capacity: [ 409, "Not enough tickets are available." ],
    hold_expired: [ 409, "Your hold has expired." ],
    payment_declined: [ 422, "Your payment was declined. Your tickets are still held." ],
    promo_not_found: [ 422, "That promo code is not valid for this event." ],
    promo_not_active: [ 422, "That promo code is not active right now." ],
    promo_not_applicable: [ 422, "That promo code does not apply to these tickets." ],
    promo_min_not_met: [ 422, "Your order does not reach the minimum for that promo code." ],
    promo_exhausted: [ 422, "That promo code has been fully redeemed." ],
    promo_user_limit: [ 422, "You have already used that promo code the maximum number of times." ],
    promo_not_stackable: [ 422, "That promo code cannot be combined with the codes already applied." ]
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
