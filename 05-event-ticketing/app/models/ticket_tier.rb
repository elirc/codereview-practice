class TicketTier < ApplicationRecord
  belongs_to :event

  validates :name, presence: true, length: { maximum: 100 }
  validates :price_cents, numericality: { only_integer: true, greater_than_or_equal_to: 0 }
  validates :capacity, numericality: { only_integer: true, greater_than_or_equal_to: 0 }
  validates :per_order_limit, numericality: { only_integer: true, greater_than: 0 }
  validates :position, numericality: { only_integer: true }

  def available
    capacity - sold_count - held_count
  end

  def committed
    sold_count + held_count
  end
end
