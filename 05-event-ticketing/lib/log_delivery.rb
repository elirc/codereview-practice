# Action Mailer delivery method that records outgoing letters in the log
# instead of sending them. Only envelope data is logged, never the body.
class LogDelivery
  attr_accessor :settings

  def initialize(settings = {})
    @settings = settings
  end

  def deliver!(mail)
    Rails.logger.info(
      {
        event: "mail.delivered",
        to: Array(mail.to),
        subject: mail.subject,
        message_id: mail.message_id
      }
    )
  end
end
