require "test_helper"

class Tiers::UpdateTest < ActiveSupport::TestCase
  setup do
    @tier = create_tier(capacity: 6, price_cents: 1_000)
    purchase(users(:customer), @tier, 2, gateway: FakeGateway.new)
    place_hold(users(:other_customer), @tier, 2)
  end

  test "capacity cannot drop below sold plus held" do
    error = assert_domain_error(:capacity_below_committed) { Tiers::Update.call(@tier, capacity: 3) }

    assert_equal 4, error.details[:committed]
    assert_equal 6, @tier.reload.capacity
  end

  test "capacity can drop to exactly what is committed" do
    tier = Tiers::Update.call(@tier, capacity: 4)

    assert tier.errors.empty?
    assert_equal 4, @tier.reload.capacity
    assert_no_enqueued_jobs(only: PromoteWaitlistJob)
  end

  test "raising capacity triggers promotion" do
    Tiers::Update.call(@tier, capacity: 10)

    assert_equal 10, @tier.reload.capacity
    assert_enqueued_with(job: PromoteWaitlistJob, args: [ @tier.id ])
  end

  test "a price change applies only to holds created afterwards" do
    existing = @tier.holds.active.sole

    Tiers::Update.call(@tier, price_cents: 2_500)
    later = place_hold(users(:organizer), @tier, 1)

    assert_equal 1_000, existing.reload.unit_price_cents
    assert_equal 2_500, later.unit_price_cents
  end

  test "invalid attributes come back as errors" do
    tier = Tiers::Update.call(@tier, name: "", capacity: "lots")

    assert tier.errors.of_kind?(:name, :blank)
    assert tier.errors.of_kind?(:capacity, :not_a_number)
    assert_equal 6, @tier.reload.capacity
  end
end
