# Idempotent development data: running `bin/rails db:seed` again updates the
# same records instead of duplicating them.

SEED_PASSWORD = "password123".freeze

def seed_user(email, name, role)
  User.find_or_initialize_by(email_address: email).tap do |user|
    user.update!(name:, role:, password: SEED_PASSWORD)
  end
end

def seed_event(organizer, title, attributes)
  Event.find_or_initialize_by(organizer:, title:).tap { |event| event.update!(attributes) }
end

def seed_tier(event, name, attributes)
  event.ticket_tiers.find_or_create_by!(name:) { |tier| tier.assign_attributes(attributes) }
end

def seed_promo(event, code, attributes)
  PromoCode.find_or_initialize_by(event:, code:).tap { |promo| promo.update!(attributes) }
end

admin = seed_user("admin@example.com", "Ada Admin", "admin")
olive = seed_user("organizer@example.com", "Olive Organizer", "organizer")
oscar = seed_user("organizer2@example.com", "Oscar Organizer", "organizer")
casey = seed_user("customer@example.com", "Casey Customer", "customer")
drew = seed_user("customer2@example.com", "Drew Customer", "customer")

starts_at = 30.days.from_now.utc.change(hour: 23, min: 0)

concert = seed_event(olive, "Harbour Lights Live", {
  description: "An evening of music on the pier, with food trucks from 6pm.",
  venue: "Pier 9, Boston",
  time_zone: "America/New_York",
  starts_at:,
  ends_at: starts_at + 3.hours,
  sales_close_at: starts_at,
  status: :published
})
general = seed_tier(concert, "General admission", { price_cents: 3_500, capacity: 200, per_order_limit: 6, position: 0 })
vip = seed_tier(concert, "VIP", { price_cents: 12_000, capacity: 20, per_order_limit: 4, position: 1 })
front_row = seed_tier(concert, "Front row", { price_cents: 9_500, capacity: 2, per_order_limit: 2, position: 2 })

seed_promo(concert, "EARLYBIRD", { kind: "percent", percent_off: 15, stackable: true, max_redemptions: 50 })
seed_promo(concert, "TENOFF", { kind: "fixed", amount_off_cents: 1_000, stackable: true })
seed_promo(concert, "VIPONLY", { kind: "percent", percent_off: 20, min_subtotal_cents: 20_000 })
  .tap { |promo| promo.update!(ticket_tiers: [ vip ]) }
seed_promo(nil, "WELCOME5", { kind: "fixed", amount_off_cents: 500, per_user_limit: 1 })

festival = seed_event(oscar, "Riverside Folk Festival", {
  description: "Two stages, twelve bands, one long summer day.",
  venue: "Riverside Park, Chicago",
  time_zone: "America/Chicago",
  starts_at: starts_at + 14.days,
  ends_at: starts_at + 14.days + 10.hours,
  sales_close_at: starts_at + 14.days - 2.hours,
  status: :published
})
seed_tier(festival, "Day pass", { price_cents: 4_000, capacity: 500, per_order_limit: 6, position: 0 })
seed_tier(festival, "Free kids pass", { price_cents: 0, capacity: 100, per_order_limit: 4, position: 1 })

draft = seed_event(olive, "Unannounced Winter Show", {
  venue: "Warehouse 4, Boston",
  time_zone: "America/New_York",
  starts_at: starts_at + 60.days,
  ends_at: starts_at + 60.days + 2.hours,
  sales_close_at: starts_at + 60.days,
  status: :draft
})
seed_tier(draft, "General admission", { price_cents: 2_500, capacity: 80, position: 0 })

# Sell out the front row and put someone on its waitlist so every screen has data.
gateway = FakeGateway.new
if front_row.reload.sold_count.zero? && front_row.held_count.zero?
  hold = Holds::Create.call(user: casey, tier: front_row, quantity: 2)
  Checkout::Complete.call(hold:, user: casey, payment_token: "tok_visa", gateway:)
end
unless front_row.waitlist_entries.pending.exists?(user: drew)
  Waitlist::Join.call(user: drew, tier: front_row, quantity: 1)
end

if general.reload.sold_count.zero?
  hold = Holds::Create.call(user: drew, tier: general, quantity: 2)
  Promos::Apply.call(hold:, user: drew, code: "earlybird")
  Checkout::Complete.call(hold:, user: drew, payment_token: "tok_visa", gateway:)
end

puts "Seeded #{User.count} users, #{Event.count} events and #{Order.count} orders (admin: #{admin.email_address})."
