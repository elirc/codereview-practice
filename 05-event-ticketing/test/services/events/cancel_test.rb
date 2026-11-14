require "test_helper"

class Events::CancelTest < ActiveSupport::TestCase
  include ActionMailer::TestHelper

  class FlakyGateway < FakeGateway
    def initialize(fail_on_refund:)
      super()
      @refund_calls = 0
      @fail_on_refund = fail_on_refund
    end

    def refund(reference, amount_cents:)
      @refund_calls += 1
      return PaymentGateway::Result.new(status: :declined, reference:, message: "unavailable") if @refund_calls == @fail_on_refund

      super
    end
  end

  setup do
    @event = events(:concert)
    @gateway = FakeGateway.new
    @tier = create_tier(capacity: 6)
    @orders = [
      purchase(users(:customer), @tier, 2, gateway: @gateway),
      purchase(users(:other_customer), @tier, 2, gateway: @gateway)
    ]
    @hold = place_hold(users(:organizer), @tier, 2)
    @entry = join_waitlist(users(:admin), @tier, 1)
  end

  def cancel(gateway: @gateway)
    Events::Cancel.call(@event, gateway:, now: NOW + 1.hour)
  end

  test "releases holds, closes the waitlist and refunds every paid order" do
    assert_enqueued_emails 2 do
      cancel
    end

    assert @event.reload.cancelled?
    assert @hold.reload.released?
    assert @entry.reload.cancelled?
    assert @orders.all? { |order| order.reload.refunded? }
    @tier.reload
    assert_equal 0, @tier.held_count
    assert_equal 0, @tier.sold_count
    assert_equal 2, @gateway.refunds.size
  end

  test "an offered waitlist hold is released and its entry cancelled" do
    Holds::Release.call(@hold)
    offer = Waitlist::Promote.call(@tier, now: NOW + 1.minute).sole

    cancel

    assert offer.reload.released?
    assert @entry.reload.cancelled?
  end

  test "re-running after a failure refunds only the orders still paid" do
    assert_domain_error(:refund_failed) { cancel(gateway: FlakyGateway.new(fail_on_refund: 2)) }

    refunded, still_paid = @orders.map(&:reload).partition(&:refunded?)
    assert_equal 1, refunded.size
    assert_equal 1, still_paid.size

    second_run = FakeGateway.new
    cancel(gateway: second_run)

    assert_equal [ still_paid.first.payment_reference ], second_run.refunds.map { |refund| refund[:reference] }
    assert @orders.all? { |order| order.reload.refunded? }
    assert_equal 0, @tier.reload.sold_count
  end

  test "running twice is harmless" do
    cancel
    cancel

    assert_equal 2, @gateway.refunds.size
  end

  test "requesting cancellation stops sales at once and schedules the job after commit" do
    ApplicationRecord.transaction do
      Events::Cancel.request(@event)
      assert_no_enqueued_jobs(only: CancelEventJob)
    end

    assert @event.reload.cancelled?
    assert_enqueued_with(job: CancelEventJob, args: [ @event.id ])
    assert_domain_error(:sales_closed) { place_hold(users(:customer), @tier, 1, now: NOW + 2.minutes) }
    assert_domain_error(:event_cancelled) do
      Checkout::Complete.call(hold: @hold, user: users(:organizer), payment_token: "tok_visa", gateway: @gateway,
        now: NOW + 2.minutes)
    end
  end

  test "the job runs the cancellation" do
    PaymentGateway.current = @gateway

    CancelEventJob.perform_now(@event.id)

    assert @orders.all? { |order| order.reload.refunded? }
  ensure
    PaymentGateway.current = nil
  end
end
