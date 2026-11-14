module Manage
  class WaitlistEntriesController < BaseController
    before_action :set_event

    def index
      @entries_by_tier = WaitlistEntry
        .joins(:ticket_tier)
        .where(ticket_tiers: { event_id: @event.id })
        .includes(:user, :ticket_tier)
        .in_queue_order
        .group_by(&:ticket_tier)
    end
  end
end
