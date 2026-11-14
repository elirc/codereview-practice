class TicketTier < ApplicationRecord
  belongs_to :event
  has_many :holds, dependent: :restrict_with_exception
  has_many :tickets, dependent: :restrict_with_exception
  has_many :waitlist_entries, dependent: :restrict_with_exception

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
  # transaction.
  def adjust_counts!(held: 0, sold: 0)
    available_before = available
    update_columns(held_count: held_count + held, sold_count: sold_count + sold)
  rescue ActiveRecord::StatementInvalid => e
    raise unless e.cause.is_a?(PG::CheckViolation)

    raise DomainError.new(:insufficient_capacity, details: { available: available_before })
  end
end
