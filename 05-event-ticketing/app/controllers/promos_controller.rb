class PromosController < ApplicationController
  before_action :set_hold

  rescue_from DomainError, with: :render_quote_error

  def create
    Promos::Apply.call(hold: @hold, user: current_user, code: params[:code].to_s)
    render_quote
  end

  def destroy
    @hold.hold_promos.find_by!(promo_code_id: params[:promo_code_id]).destroy!
    render_quote
  end

  private
    def set_hold
      @hold = current_user.holds.find(params[:hold_id])
    end

    def render_quote_error(error)
      render_quote(error:)
    end

    def render_quote(error: nil)
      @hold.reload
      quote = Pricing::Quote.call(@hold, @hold.promo_codes.to_a)

      respond_to do |format|
        format.turbo_stream do
          render turbo_stream: turbo_stream.replace("quote", partial: "holds/quote",
            locals: { hold: @hold, quote:, error: }), status: error ? error.status : :ok
        end
        format.html do
          flash_options = error ? { alert: error.message, flash: { error_code: error.code.to_s } } : {}
          redirect_to hold_path(@hold), status: :see_other, **flash_options
        end
      end
    end
end
