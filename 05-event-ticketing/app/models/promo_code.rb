class PromoCode < ApplicationRecord
  include ZonedTimeInput

  MAX_PER_HOLD = 2
  CODE_FORMAT = /\A[A-Z0-9_-]+\z/

  belongs_to :event, optional: true
  has_many :promo_code_tiers, dependent: :delete_all
  has_many :ticket_tiers, through: :promo_code_tiers
  has_many :hold_promos, dependent: :delete_all
  has_many :promo_redemptions, dependent: :restrict_with_exception

  enum :kind, { percent: "percent", fixed: "fixed" }, validate: true

  normalizes :code, with: ->(code) { code.strip.upcase }

  zoned_time_input :starts_at, :ends_at

  validates :code, presence: true, length: { maximum: 40 },
    format: { with: CODE_FORMAT, message: "may contain only letters, digits, - and _" }
  validates :code, uniqueness: { scope: :event_id }
  validates :percent_off, numericality: {
    only_integer: true, greater_than_or_equal_to: 1, less_than_or_equal_to: 100
  }, if: :percent?
  validates :percent_off, absence: true, unless: :percent?
  validates :amount_off_cents, numericality: { only_integer: true, greater_than: 0 }, if: :fixed?
  validates :amount_off_cents, absence: true, unless: :fixed?
  validates :per_user_limit, numericality: { only_integer: true, greater_than: 0 }
  validates :max_redemptions, numericality: { only_integer: true, greater_than: 0 }, allow_nil: true
  validates :min_subtotal_cents, numericality: { only_integer: true, greater_than_or_equal_to: 0 }
  validate :window_is_ordered

  def self.normalize_code(text)
    text.to_s.strip.upcase
  end

  # Finds the code a customer typed for an event. A code defined on the event
  # takes precedence over a site-wide code with the same text.
  def self.lookup(text, event)
    code = normalize_code(text)
    return if code.empty?

    find_by(event_id: event.id, code:) || find_by(event_id: nil, code:)
  end

  def in_window?(now)
    (starts_at.nil? || starts_at <= now) && (ends_at.nil? || now < ends_at)
  end

  def applies_to_tier?(tier_id)
    tier_ids = ticket_tier_ids
    tier_ids.empty? || tier_ids.include?(tier_id)
  end

  def exhausted?
    max_redemptions.present? && redemptions_count >= max_redemptions
  end

  def site_wide?
    event_id.nil?
  end

  def input_time_zone
    event&.time_zone || "UTC"
  end

  private
    def window_is_ordered
      return if starts_at.blank? || ends_at.blank?

      errors.add(:ends_at, "must be after the start") unless ends_at > starts_at
    end
end
