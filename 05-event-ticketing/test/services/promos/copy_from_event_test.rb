require "test_helper"

class Promos::CopyFromEventTest < ActiveSupport::TestCase
  setup do
    @source = events(:draft_show)
    @target = events(:concert)
  end

  test "copies discounts and limits but not windows, tiers or redemptions" do
    promo = create_promo("SPRING", event: @source, percent_off: 15, stackable: true, max_redemptions: 50,
      per_user_limit: 2, min_subtotal_cents: 1_000, starts_at: NOW, ends_at: NOW + 7.days)
    promo.ticket_tiers << ticket_tiers(:draft_general)
    promo.update_columns(redemptions_count: 12)

    copy = Promos::CopyFromEvent.call(source: @source, target: @target).sole

    assert_equal @target, copy.event
    assert_equal "SPRING", copy.code
    assert copy.percent?
    assert_equal 15, copy.percent_off
    assert copy.stackable?
    assert_equal 50, copy.max_redemptions
    assert_equal 2, copy.per_user_limit
    assert_equal 1_000, copy.min_subtotal_cents
    assert_equal 0, copy.redemptions_count
    assert_nil copy.starts_at
    assert_nil copy.ends_at
    assert_empty copy.ticket_tiers
  end

  test "skips codes the target already has" do
    create_promo("KEEP", event: @source, amount_off_cents: 500)
    create_promo("NEW", event: @source, amount_off_cents: 300)
    existing = create_promo("KEEP", event: @target, amount_off_cents: 100)

    copied = Promos::CopyFromEvent.call(source: @source, target: @target)

    assert_equal %w[ NEW ], copied.map(&:code)
    assert_equal 100, existing.reload.amount_off_cents
    assert_equal %w[ KEEP NEW ], @target.promo_codes.order(:code).pluck(:code)
  end
end
