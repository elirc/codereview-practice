class Ticket < ApplicationRecord
  belongs_to :order
  belongs_to :ticket_tier

  enum :status, { valid: "valid", void: "void" }, prefix: true

  validates :code, presence: true, length: { is: 12 }
end
