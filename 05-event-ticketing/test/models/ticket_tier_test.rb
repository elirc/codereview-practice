require "test_helper"

class TicketTierTest < ActiveSupport::TestCase
  test "available is capacity minus sold and held" do
    tier = TicketTier.new(capacity: 10, sold_count: 3, held_count: 2)

    assert_equal 5, tier.available
    assert_equal 5, tier.committed
  end

  test "the database refuses more committed tickets than capacity" do
    tier = ticket_tiers(:vip)

    assert_raises(ActiveRecord::StatementInvalid) do
      TicketTier.transaction(requires_new: true) do
        tier.update_columns(sold_count: 6, held_count: 5)
      end
    end
    assert_equal 0, tier.reload.sold_count
  end

  test "the database refuses negative counters" do
    tier = ticket_tiers(:vip)

    assert_raises(ActiveRecord::StatementInvalid) do
      TicketTier.transaction(requires_new: true) { tier.update_columns(held_count: -1) }
    end
  end

  test "validates prices and limits" do
    tier = TicketTier.new(event: events(:concert), name: "", price_cents: -1, capacity: 1, per_order_limit: 0)

    assert_not tier.valid?
    assert tier.errors.of_kind?(:name, :blank)
    assert tier.errors.of_kind?(:price_cents, :greater_than_or_equal_to)
    assert tier.errors.of_kind?(:per_order_limit, :greater_than)
  end
end
