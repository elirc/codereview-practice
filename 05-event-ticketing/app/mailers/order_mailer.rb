class OrderMailer < ApplicationMailer
  def confirmation(order)
    load_order(order)
    mail to: order.user.email_address, subject: "Your tickets for #{@event.title} (#{order.number})"
  end

  def refunded(order)
    load_order(order)
    mail to: order.user.email_address, subject: "Refund for order #{order.number}"
  end

  def event_cancelled(order)
    load_order(order)
    mail to: order.user.email_address, subject: "#{@event.title} is cancelled — order #{order.number} refunded"
  end

  private
    def load_order(order)
      @order = order
      @event = order.event
      @tickets = order.tickets.includes(:ticket_tier).order(:created_at)
    end
end
