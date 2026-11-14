module Api
  class EventsController < BaseController
    def availability
      event = Event.published.find(params[:id])
      tiers = TierAvailability.for_event(event, now: Time.current).map do |availability|
        { id: availability.tier.id, available: availability.available, waitlist_open: availability.waitlist_open? }
      end

      render json: { tiers: }
    end
  end
end
