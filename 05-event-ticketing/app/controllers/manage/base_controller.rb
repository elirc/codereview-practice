module Manage
  class BaseController < ApplicationController
    before_action :require_manager

    private
      def require_manager
        authorize!(current_user.manager?)
      end

      def manageable_events
        EventPolicy.manageable_scope(current_user)
      end

      def set_event
        @event = manageable_events.find(params[:event_id])
      end

      def refuse_cancelled_event
        raise DomainError.new(:event_cancelled) if @event.cancelled?
      end

      def error_fallback_location
        @event&.persisted? ? manage_event_path(@event) : manage_events_path
      end
  end
end
