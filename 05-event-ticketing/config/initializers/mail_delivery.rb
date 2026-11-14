require Rails.root.join("lib", "log_delivery").to_s

ActiveSupport.on_load(:action_mailer) do
  add_delivery_method :log, LogDelivery
end
