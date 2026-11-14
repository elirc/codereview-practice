class PromoRedemption < ApplicationRecord
  belongs_to :promo_code
  belongs_to :order
  belongs_to :user

  validates :amount_cents, numericality: { only_integer: true, greater_than_or_equal_to: 0 }
end
