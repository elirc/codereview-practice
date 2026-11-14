Rails.application.routes.draw do
  root "events#index"

  resource :session, only: %i[ new create destroy ]
  resource :registration, only: %i[ new create ]

  resources :events, only: :show

  resources :tiers, only: [] do
    resources :holds, only: :create
  end

  resources :holds, only: %i[ show destroy ] do
    resource :checkout, only: :create
  end

  resources :orders, only: %i[ index show ], param: :number

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
