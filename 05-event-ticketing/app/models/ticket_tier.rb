class TicketTier < ApplicationRecord
  belongs_to :event
  has_many :holds, dependent: :restrict_with_exception
  has_many :tickets, dependent: :restrict_with_exception

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

  # Applies counter deltas to a tier the caller has locked in the current
  # transaction. The in-memory counts are updated only when the row is.
  def adjust_counts!(held: 0, sold: 0)
    update_columns(held_count: held_count + held, sold_count: sold_count + sold)
  rescue ActiveRecord::StatementInvalid => e
    raise unless e.cause.is_a?(PG::CheckViolation)

    raise DomainError.new(:insufficient_capacity, details: { available: })
  end
end
