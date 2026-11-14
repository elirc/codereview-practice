Rails.application.routes.draw do
  root "events#index"

  resource :session, only: %i[ new create destroy ]
  resource :registration, only: %i[ new create ]

  resources :events, only: :show

  namespace :manage do
    resources :events do
      member do
        post :publish
      end

      resources :tiers, only: %i[ new create edit update ]
    end
  end

  get "up" => "rails/health#show", as: :rails_health_check
end
