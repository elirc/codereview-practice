module Manage
  class OrdersController < BaseController
    before_action :set_event
    before_action :set_order, only: %i[ show refund ]

    def index
      @orders = @event.orders.includes(:user, :tickets).order(created_at: :desc)
    end

    def show
    end

    def refund
      Orders::Refund.call(@order)
      redirect_to manage_event_order_path(@event, @order), notice: "Order #{@order.number} refunded."
    end

    private
      def set_order
        @order = @event.orders
          .includes(:user, tickets: :ticket_tier, promo_redemptions: :promo_code)
          .find_by!(number: params[:number])
      end

      def error_fallback_location
        @order ? manage_event_order_path(@event, @order) : super
      end
  end
end
