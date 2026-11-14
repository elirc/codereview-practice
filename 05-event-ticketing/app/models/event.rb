class Event < ApplicationRecord
  include ZonedTimeInput

  belongs_to :organizer, class_name: "User"
  has_many :ticket_tiers, -> { order(:position, :created_at) }, dependent: :destroy, inverse_of: :event
  has_many :orders, dependent: :restrict_with_exception
  has_many :promo_codes, dependent: :destroy

  enum :status, { draft: "draft", published: "published", cancelled: "cancelled" }, default: :draft

  zoned_time_input :starts_at, :ends_at, :sales_close_at

  before_validation :default_sales_close_at

  validates :title, presence: true, length: { maximum: 200 }
  validates :venue, presence: true, length: { maximum: 200 }
  validates :description, length: { maximum: 5_000 }
  validates :time_zone, inclusion: {
    in: ->(_event) { TZInfo::Timezone.all_identifiers },
    message: "must be an IANA time zone such as America/New_York"
  }
  validates :starts_at, :ends_at, :sales_close_at, presence: true
  validate :ends_after_start

  scope :listed, -> { published.order(:starts_at) }

  def self.time_zone_options
    ActiveSupport::TimeZone.all.map { |zone| zone.tzinfo.identifier }.uniq.sort
  end

  def on_sale?(now)
    published? && now < sales_close_at
  end

  def publish!
    with_lock do
      raise DomainError.new(:event_not_draft) unless draft?

      update!(status: :published)
    end
  end

  def input_time_zone
    time_zone
  end

  private
    def default_sales_close_at
      self.sales_close_at = starts_at if sales_close_at.blank?
    end

    def ends_after_start
      return if starts_at.blank? || ends_at.blank?

      errors.add(:ends_at, "must be after the start") unless ends_at > starts_at
    end
end
