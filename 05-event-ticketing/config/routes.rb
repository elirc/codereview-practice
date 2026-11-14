Rails.application.routes.draw do
  root "events#index"

  resource :session, only: %i[ new create destroy ]
  resource :registration, only: %i[ new create ]

  resources :events, only: :show

  resources :tiers, only: [] do
    resources :holds, only: :create
    resources :waitlist_entries, only: :create
  end

  resources :holds, only: %i[ show destroy ] do
    resources :promos, only: %i[ create destroy ], param: :promo_code_id
    resource :checkout, only: :create
  end

  resources :orders, only: %i[ index show ], param: :number
  resources :waitlist_entries, only: :destroy

  namespace :manage do
    resources :events do
      member do
        post :publish
      end

      resources :tiers, only: %i[ new create edit update ]
      resources :promo_codes, only: %i[ index new create edit update ]
      resources :waitlist_entries, only: :index
    end
  end

  get "up" => "rails/health#show", as: :rails_health_check
end
