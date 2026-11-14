# Base class for tests that exercise row locking from several threads. Each
# thread uses its own database connection, so these tests cannot run inside
# a wrapping transaction and clean up after themselves instead.
class ConcurrencyTestCase < ActiveSupport::TestCase
  self.use_transactional_tests = false

  CLEANUP_ORDER = [
    PromoRedemption, HoldPromo, Ticket, Hold, WaitlistEntry, Order, PromoCodeTier, PromoCode
  ].freeze

  setup do
    @created_users = []
    @event = Event.create!(
      organizer: users(:organizer), title: "Race Night", venue: "Track", time_zone: "UTC",
      starts_at: NOW + 30.days, ends_at: NOW + 30.days + 3.hours, status: :published
    )
    @gateway = FakeGateway.new
  end

  teardown do
    CLEANUP_ORDER.each(&:delete_all)
    TicketTier.where(event_id: @event.id).delete_all
    @event.delete
    User.where(id: @created_users.map(&:id)).delete_all
  end

  def concurrent_tier(capacity:, price_cents: 1_000)
    @event.ticket_tiers.create!(name: "Tier #{SecureRandom.hex(2)}", capacity:, price_cents:, per_order_limit: 6)
  end

  def customers(count)
    Array.new(count) { create_customer("Racer") }.tap { |created| @created_users.concat(created) }
  end

  # Runs the block once per index, each on its own thread and connection,
  # and releases the threads together. Returns what each block returned, or
  # the code of the DomainError it raised.
  def run_concurrently(count)
    ready = Queue.new
    start = Queue.new

    threads = Array.new(count) do |index|
      Thread.new do
        ActiveRecord::Base.connection_pool.with_connection do
          ready << true
          start.pop
          yield index
        rescue DomainError => e
          e.code
        end
      end
    end

    count.times { ready.pop }
    count.times { start << true }
    threads.map(&:value)
  end
end
