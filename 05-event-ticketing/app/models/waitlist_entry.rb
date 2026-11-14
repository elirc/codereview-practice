class WaitlistEntry < ApplicationRecord
  OPEN_STATUSES = %w[ waiting offered ].freeze

  belongs_to :user
  belongs_to :ticket_tier
  has_one :hold, dependent: :restrict_with_exception

  enum :status, {
    waiting: "waiting", offered: "offered", converted: "converted", expired: "expired", cancelled: "cancelled"
  }

  scope :pending, -> { where(status: OPEN_STATUSES) }
  scope :in_queue_order, -> { order(:created_at, :id) }

  validates :quantity, numericality: { only_integer: true, greater_than: 0 }

  def open?
    OPEN_STATUSES.include?(status)
  end

  # 1-based place among waiting entries of the tier.
  def position
    return unless waiting?

    ahead = ticket_tier.waitlist_entries.waiting.where("(created_at, id) < (?, ?)", created_at, id)
    ahead.count + 1
  end
end
