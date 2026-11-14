class EventsController < ApplicationController
  allow_unauthenticated_access

  def index
    @events = Event.listed.includes(:ticket_tiers)
  end

  def show
    @event = EventPolicy.visible_scope(current_user).find(params[:id])
    @tiers = @event.ticket_tiers
  end
end
