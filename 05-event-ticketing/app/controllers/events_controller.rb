class EventsController < ApplicationController
  allow_unauthenticated_access

  def index
    @events = Event.listed.includes(:ticket_tiers)
  end

  def show
    @event = EventPolicy.visible_scope(current_user).find(params[:id])
    @now = Time.current
    @availabilities = TierAvailability.for_event(@event, now: @now)
    @my_entries = my_waitlist_entries
  end

  private
    def my_waitlist_entries
      return {} unless authenticated?

      current_user.waitlist_entries.pending
        .where(ticket_tier_id: @availabilities.map { |availability| availability.tier.id })
        .includes(:hold)
        .index_by(&:ticket_tier_id)
    end
end
