class OrderMailer < ApplicationMailer
  def confirmation(order)
    @order = order
    @event = order.event
    @tickets = order.tickets.includes(:ticket_tier).order(:created_at)

    mail to: order.user.email_address, subject: "Your tickets for #{@event.title} (#{order.number})"
  end
end
