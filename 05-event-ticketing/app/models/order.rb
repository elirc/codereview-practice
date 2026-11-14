class Order < ApplicationRecord
  NUMBER_FORMAT = /\AORD-[A-Z2-7]{8}\z/

  belongs_to :user
  belongs_to :event
  has_many :tickets, dependent: :restrict_with_exception
  has_one :hold, dependent: :restrict_with_exception

  enum :status, { paid: "paid", refunded: "refunded" }

  validates :number, presence: true, format: { with: NUMBER_FORMAT }
  validates :subtotal_cents, :discount_cents, :total_cents,
    numericality: { only_integer: true, greater_than_or_equal_to: 0 }
  validate :total_matches_amounts

  def to_param
    number
  end

  private
    def total_matches_amounts
      return if [ subtotal_cents, discount_cents, total_cents ].any?(&:nil?)

      errors.add(:total_cents, "must equal subtotal minus discount") unless total_cents == subtotal_cents - discount_cents
    end
end
