module Waitlist
  # Offers freed tickets to waiting entries in queue order. Each offer is a
  # hold the customer can check out before it expires.
  class Promote
    OFFER_TTL = 30.minutes

    def self.call(...)
      new(...).call
    end

    def initialize(tier, now: Time.current)
      @tier_id = tier.id
      @now = now
    end

    def call
      offers = ApplicationRecord.transaction do
        tier = TicketTier.lock.find(@tier_id)
        event = tier.event
        made = []

        tier.waitlist_entries.waiting.in_queue_order.each do |entry|
          break unless event.on_sale?(@now)
          next if superseded_by_direct_hold?(entry, tier)
          break if tier.available < entry.quantity

          made << offer(entry, tier)
        end

        made
      end

      ActiveRecord.after_all_transactions_commit do
        offers.each do |hold|
          ExpireHoldJob.set(wait_until: hold.expires_at).perform_later(hold.id)
          WaitlistMailer.offer(hold.waitlist_entry).deliver_later
        end
      end
      offers
    end

    private
      def superseded_by_direct_hold?(entry, tier)
        hold = Hold.active.lock.find_by(user_id: entry.user_id, ticket_tier_id: tier.id)
        return false if hold.nil?

        if hold.live?(@now)
          entry.update!(status: :cancelled)
          true
        else
          Holds::Closing.close!(hold, tier, status: :expired)
          false
        end
      end

      def offer(entry, tier)
        hold = Hold.create!(
          user_id: entry.user_id,
          ticket_tier: tier,
          quantity: entry.quantity,
          unit_price_cents: tier.price_cents,
          status: :active,
          source: :waitlist,
          waitlist_entry: entry,
          expires_at: @now + OFFER_TTL
        )
        tier.adjust_counts!(held: entry.quantity)
        entry.update!(status: :offered, offered_at: @now, offer_expires_at: hold.expires_at)
        hold
      end
  end
end
