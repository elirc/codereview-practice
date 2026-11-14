class WaitlistMailer < ApplicationMailer
  def offer(entry)
    @entry = entry
    @hold = entry.hold
    @tier = entry.ticket_tier
    @event = @tier.event

    mail to: entry.user.email_address, subject: "Tickets are waiting for you: #{@event.title}"
  end
end
