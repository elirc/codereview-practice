class PromoCodeTier < ApplicationRecord
  belongs_to :promo_code
  belongs_to :ticket_tier
end
