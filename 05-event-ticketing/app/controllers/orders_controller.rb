class OrdersController < ApplicationController
  def index
    @orders = current_user.orders.includes(:event).order(created_at: :desc)
  end

  def show
    @order = current_user.orders.includes(:event, tickets: :ticket_tier).find_by!(number: params[:number])
  end
end
