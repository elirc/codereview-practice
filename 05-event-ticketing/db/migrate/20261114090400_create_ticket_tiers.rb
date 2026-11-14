class CreateTicketTiers < ActiveRecord::Migration[8.0]
  def change
    create_table :ticket_tiers, id: :uuid do |t|
      t.references :event, null: false, type: :uuid, foreign_key: true, index: false
      t.string :name, null: false
      t.integer :price_cents, null: false
      t.integer :capacity, null: false
      t.integer :sold_count, null: false, default: 0
      t.integer :held_count, null: false, default: 0
      t.integer :per_order_limit, null: false, default: 6
      t.integer :position, null: false, default: 0

      t.timestamps
    end

    add_index :ticket_tiers, [ :event_id, :position ]

    add_check_constraint :ticket_tiers, "price_cents >= 0", name: "ticket_tiers_price_nonnegative"
    add_check_constraint :ticket_tiers, "capacity >= 0", name: "ticket_tiers_capacity_nonnegative"
    add_check_constraint :ticket_tiers, "sold_count >= 0", name: "ticket_tiers_sold_count_nonnegative"
    add_check_constraint :ticket_tiers, "held_count >= 0", name: "ticket_tiers_held_count_nonnegative"
    add_check_constraint :ticket_tiers, "sold_count + held_count <= capacity",
      name: "ticket_tiers_committed_within_capacity"
    add_check_constraint :ticket_tiers, "per_order_limit > 0", name: "ticket_tiers_per_order_limit_positive"
  end
end
