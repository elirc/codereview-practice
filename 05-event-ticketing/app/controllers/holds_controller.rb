class HoldsController < ApplicationController
  before_action :set_hold, only: %i[ show destroy ]

  def create
    @tier = TicketTier.find(params[:tier_id])
    raise ActiveRecord::RecordNotFound unless EventPolicy.new(current_user, @tier.event).show?

    hold = Holds::Create.call(user: current_user, tier: @tier, quantity: integer_param(:quantity))
    redirect_to hold_path(hold)
  end

  def show
    @tier = @hold.ticket_tier
    @event = @tier.event
    @now = Time.current
  end

  def destroy
    if Holds::Release.call(@hold)
      redirect_to event_path(@hold.ticket_tier.event_id), notice: "Your tickets were released.", status: :see_other
    else
      redirect_to event_path(@hold.ticket_tier.event_id), alert: "That hold is no longer active.", status: :see_other
    end
  end

  private
    def set_hold
      @hold = current_user.holds.includes(ticket_tier: :event).find(params[:id])
    end

    def error_fallback_location
      @tier ? event_path(@tier.event_id) : root_path
    end
end
