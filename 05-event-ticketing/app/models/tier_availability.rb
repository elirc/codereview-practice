# How each tier of an event can be bought at a given moment: held directly,
# joined via the waitlist, or not at all.
class TierAvailability
  attr_reader :tier

  def self.for_event(event, now:)
    tiers = event.ticket_tiers.to_a
    queued_tier_ids = WaitlistEntry.pending.where(ticket_tier_id: tiers.map(&:id)).distinct.pluck(:ticket_tier_id)
    on_sale = event.on_sale?(now)

    tiers.map { |tier| new(tier, waitlist_active: queued_tier_ids.include?(tier.id), on_sale:) }
  end

  def initialize(tier, waitlist_active:, on_sale:)
    @tier = tier
    @waitlist_active = waitlist_active
    @on_sale = on_sale
  end

  def available
    tier.available
  end

  def state
    return :closed unless @on_sale
    return :waitlist if @waitlist_active

    available.positive? ? :available : :sold_out
  end

  def holdable?
    state == :available
  end

  def waitlist_open?
    @on_sale && (@waitlist_active || available.zero?)
  end
end
