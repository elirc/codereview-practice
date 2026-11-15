module Manage
  class EventsController < BaseController
    before_action :set_managed_event, except: %i[ index new create ]
    before_action :refuse_cancelled_event, only: %i[ edit update destroy publish ]

    def index
      @events = manageable_events.includes(:organizer).order(starts_at: :desc)
    end

    def show
      @tiers = @event.ticket_tiers
    end

    def new
      @event = Event.new(time_zone: "America/New_York")
    end

    def create
      @event = Event.new(event_params)
      @event.organizer = current_user

      if @event.save
        redirect_to manage_event_path(@event), notice: @event.published? ? "Event published." : "Event created as a draft."
      else
        render :new, status: :unprocessable_entity
      end
    end

    def edit
    end

    def update
      if @event.update(event_params)
        redirect_to manage_event_path(@event), notice: "Event updated."
      else
        render :edit, status: :unprocessable_entity
      end
    end

    def destroy
      raise DomainError.new(:event_not_draft) unless @event.draft?

      @event.destroy!
      redirect_to manage_events_path, notice: "Draft deleted.", status: :see_other
    end

    def publish
      @event.publish!
      redirect_to manage_event_path(@event), notice: "Event published."
    end

    def cancel
      Events::Cancel.request(@event)
      redirect_to manage_event_path(@event), notice: "Event cancelled. Holds are being released and orders refunded."
    end

    private
      def set_managed_event
        @event = manageable_events.find(params[:id])
      end

      def event_params
        params.require(:event).permit(
          :title, :description, :venue, :time_zone, :starts_at_local, :ends_at_local, :sales_close_at_local, :status
        )
      end
  end
end
