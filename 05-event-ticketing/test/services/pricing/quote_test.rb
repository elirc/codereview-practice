require "test_helper"

class Pricing::QuoteTest < ActiveSupport::TestCase
  def hold(unit_price_cents, quantity = 1)
    Hold.new(unit_price_cents:, quantity:)
  end

  def percent(percent_off, code: "PCT#{percent_off}")
    PromoCode.new(code:, kind: "percent", percent_off:, stackable: true)
  end

  def fixed(amount_off_cents, code: "FIX#{amount_off_cents}")
    PromoCode.new(code:, kind: "fixed", amount_off_cents:, stackable: true)
  end

  test "without codes the total is the subtotal" do
    quote = Pricing::Quote.call(hold(2_500, 3), [])

    assert_equal 7_500, quote.subtotal_cents
    assert_equal 0, quote.discount_cents
    assert_equal 7_500, quote.total_cents
    assert_empty quote.lines
  end

  test "percent discounts round half up to the cent" do
    assert_equal 500, Pricing::Quote.call(hold(3_333), [ percent(15) ]).discount_cents
    assert_equal 101, Pricing::Quote.call(hold(1_005), [ percent(10) ]).discount_cents
    assert_equal 100, Pricing::Quote.call(hold(1_004), [ percent(10) ]).discount_cents
  end

  test "percent applies before fixed regardless of entry order" do
    codes = [ fixed(900), percent(50) ]

    [ codes, codes.reverse ].each do |entry_order|
      quote = Pricing::Quote.call(hold(1_000), entry_order)

      assert_equal %w[ PCT50 FIX900 ], quote.lines.map { |line| line.promo_code.code }
      assert_equal [ 500, 500 ], quote.lines.map(&:amount_cents)
      assert_equal 0, quote.total_cents
    end
  end

  test "a fixed discount larger than the remaining total floors at zero" do
    quote = Pricing::Quote.call(hold(1_200, 2), [ fixed(5_000) ])

    assert_equal 2_400, quote.lines.sole.amount_cents
    assert_equal 2_400, quote.discount_cents
    assert_equal 0, quote.total_cents
  end

  test "two fixed codes never take the total below zero" do
    quote = Pricing::Quote.call(hold(1_000), [ fixed(700, code: "A"), fixed(700, code: "B") ])

    assert_equal [ 700, 300 ], quote.lines.map(&:amount_cents)
    assert_equal 0, quote.total_cents
  end

  test "percent and fixed combine on the subtotal" do
    quote = Pricing::Quote.call(hold(4_000, 2), [ percent(10), fixed(1_000) ])

    assert_equal 8_000, quote.subtotal_cents
    assert_equal [ 800, 1_000 ], quote.lines.map(&:amount_cents)
    assert_equal 1_800, quote.discount_cents
    assert_equal 6_200, quote.total_cents
  end

  test "a hundred percent code makes the order free" do
    assert_equal 0, Pricing::Quote.call(hold(999, 3), [ percent(100) ]).total_cents
  end
end
