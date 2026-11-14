Rails.application.routes.draw do
  root "sessions#new"

  resource :session, only: %i[ new create destroy ]
  resource :registration, only: %i[ new create ]

  get "up" => "rails/health#show", as: :rails_health_check
end
