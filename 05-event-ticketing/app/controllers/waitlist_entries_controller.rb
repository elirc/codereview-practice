class WaitlistEntriesController < ApplicationController
  def create
    @tier = TicketTier.find(params[:tier_id])
    raise ActiveRecord::RecordNotFound unless EventPolicy.new(current_user, @tier.event).show?

    Waitlist::Join.call(user: current_user, tier: @tier, quantity: integer_param(:quantity))
    redirect_to event_path(@tier.event_id), notice: "You're on the waitlist. We'll email you when tickets are offered."
  end

  def destroy
    entry = current_user.waitlist_entries.find(params[:id])
    @tier = entry.ticket_tier

    Waitlist::Leave.call(entry)
    redirect_to event_path(@tier.event_id), notice: "You left the waitlist.", status: :see_other
  end

  private
    def error_fallback_location
      @tier ? event_path(@tier.event_id) : root_path
    end
end
