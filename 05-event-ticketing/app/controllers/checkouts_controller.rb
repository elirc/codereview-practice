class CheckoutsController < ApplicationController
  MAX_TOKEN_LENGTH = 200

  def create
    @hold = current_user.holds.find(params[:hold_id])
    order = Checkout::Complete.call(hold: @hold, user: current_user, payment_token:)

    redirect_to order_path(order), notice: "Payment received. Your tickets are below."
  end

  private
    def payment_token
      token = params.require(:payment_token).to_s
      if token.length > MAX_TOKEN_LENGTH
        raise DomainError.validation([ { path: "payment_token", message: "is too long" } ])
      end

      token
    end

    def error_fallback_location
      @hold ? hold_path(@hold) : root_path
    end
end
