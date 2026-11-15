module Manage
  class PromoCodesController < BaseController
    before_action :set_event
    before_action :refuse_cancelled_event, except: :index
    before_action :set_promo_code, only: %i[ edit update ]

    def index
      @promo_codes = @event.promo_codes.includes(:ticket_tiers).order(:code)
      @import_sources = manageable_events.where.not(id: @event.id).order(starts_at: :desc)
    end

    def new
      @promo_code = @event.promo_codes.new(kind: :percent)
    end

    def create
      @promo_code = @event.promo_codes.new(promo_code_params)
      @promo_code.ticket_tier_ids = selected_tier_ids

      if @promo_code.save
        redirect_to manage_event_promo_codes_path(@event), notice: "Promo code #{@promo_code.code} created."
      else
        render :new, status: :unprocessable_entity
      end
    end

    def edit
    end

    def update
      saved = PromoCode.transaction do
        @promo_code.ticket_tier_ids = selected_tier_ids
        @promo_code.update(promo_code_params) || raise(ActiveRecord::Rollback)
      end

      if saved
        redirect_to manage_event_promo_codes_path(@event), notice: "Promo code #{@promo_code.code} updated."
      else
        render :edit, status: :unprocessable_entity
      end
    end

    def import
      source = EventPolicy.visible_scope(current_user).where.not(id: @event.id).find(params.require(:source_event_id))
      copied = Promos::CopyFromEvent.call(source:, target: @event)

      redirect_to manage_event_promo_codes_path(@event),
        notice: "Copied #{copied.size} promo #{"code".pluralize(copied.size)} from #{source.title}."
    end

    private
      def set_promo_code
        @promo_code = @event.promo_codes.find(params[:id])
      end

      def promo_code_params
        params.require(:promo_code).permit(
          :code, :kind, :percent_off, :amount_off_cents, :stackable, :max_redemptions, :per_user_limit,
          :min_subtotal_cents, :starts_at_local, :ends_at_local, :active
        )
      end

      # Only tiers of this event can be attached; anything else is dropped.
      def selected_tier_ids
        requested = params.fetch(:promo_code, {}).permit(ticket_tier_ids: [])[:ticket_tier_ids]
        @event.ticket_tiers.where(id: Array(requested).compact_blank).pluck(:id)
      end
  end
end
