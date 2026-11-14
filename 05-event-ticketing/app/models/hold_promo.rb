class HoldPromo < ApplicationRecord
  belongs_to :hold
  belongs_to :promo_code
end
