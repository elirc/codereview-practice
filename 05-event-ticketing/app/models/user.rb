class User < ApplicationRecord
  has_secure_password

  has_many :sessions, dependent: :destroy
  has_many :organized_events, class_name: "Event", foreign_key: :organizer_id,
    inverse_of: :organizer, dependent: :restrict_with_exception
  has_many :holds, dependent: :restrict_with_exception
  has_many :orders, dependent: :restrict_with_exception
  has_many :waitlist_entries, dependent: :restrict_with_exception

  enum :role, { customer: "customer", organizer: "organizer", admin: "admin" }, default: :customer, validate: true

  normalizes :email_address, with: ->(email) { email.strip.downcase }

  validates :email_address, presence: true, uniqueness: true, length: { maximum: 254 },
    format: { with: URI::MailTo::EMAIL_REGEXP }
  validates :name, presence: true, length: { maximum: 100 }
  validates :password, length: { minimum: 8 }, allow_nil: true

  def manager?
    organizer? || admin?
  end
end
