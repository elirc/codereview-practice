module Manage
  class TiersController < BaseController
    before_action :set_event
    before_action :refuse_cancelled_event
    before_action :set_tier, only: %i[ edit update ]

    def new
      @tier = @event.ticket_tiers.new(position: @event.ticket_tiers.size)
    end

    def create
      @tier = @event.ticket_tiers.new(tier_params)

      if @tier.save
        redirect_to manage_event_path(@event), notice: "Tier added."
      else
        render :new, status: :unprocessable_entity
      end
    end

    def edit
    end

    def update
      if @tier.update(tier_params)
        redirect_to manage_event_path(@event), notice: "Tier updated."
      else
        render :edit, status: :unprocessable_entity
      end
    end

    private
      def set_tier
        @tier = @event.ticket_tiers.find(params[:id])
      end

      def tier_params
        params.require(:ticket_tier).permit(:name, :price_cents, :capacity, :per_order_limit, :position)
      end
  end
end
