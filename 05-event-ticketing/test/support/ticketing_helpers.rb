module TicketingHelpers
  NOW = Time.utc(2030, 5, 1, 12, 0, 0)

  def assert_domain_error(code, &block)
    error = assert_raises(DomainError, &block)
    assert_equal code, error.code, "expected #{code}, got #{error.code}: #{error.message}"
    error
  end

  def create_customer(name = "Customer")
    User.create!(
      name:, email_address: "#{name.parameterize}-#{SecureRandom.hex(4)}@example.com",
      password: SessionTestHelper::PASSWORD
    )
  end

  def create_tier(event: events(:concert), capacity: 10, price_cents: 1_000, per_order_limit: 6, name: "Small room")
    event.ticket_tiers.create!(name:, capacity:, price_cents:, per_order_limit:, position: 9)
  end

  def place_hold(user, tier, quantity, now: NOW)
    Holds::Create.call(user:, tier:, quantity:, now:)
  end

  def create_promo(code, event: events(:concert), percent_off: nil, amount_off_cents: nil, **attributes)
    kind = percent_off ? "percent" : "fixed"
    PromoCode.create!(event:, code:, kind:, percent_off:, amount_off_cents:, **attributes)
  end

  def apply_promo(hold, code, user: hold.user, now: NOW)
    Promos::Apply.call(hold:, user:, code:, now:)
  end
end

ActiveSupport.on_load(:active_support_test_case) do
  include TicketingHelpers
  include ActiveJob::TestHelper
end
