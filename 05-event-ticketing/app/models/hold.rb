class Hold < ApplicationRecord
  DIRECT_TTL = 10.minutes

  belongs_to :user
  belongs_to :ticket_tier
  belongs_to :order, optional: true

  enum :status, { active: "active", converted: "converted", released: "released", expired: "expired" }
  enum :source, { direct: "direct", waitlist: "waitlist" }, prefix: true

  validates :quantity, numericality: { only_integer: true, greater_than: 0 }
  validates :unit_price_cents, numericality: { only_integer: true, greater_than_or_equal_to: 0 }
  validates :expires_at, presence: true

  scope :live, ->(now) { active.where(arel_table[:expires_at].gt(now)) }

  def live?(now)
    active? && expires_at > now
  end

  def subtotal_cents
    unit_price_cents * quantity
  end
end
