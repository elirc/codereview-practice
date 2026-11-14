class CreateOrdersAndTickets < ActiveRecord::Migration[8.0]
  def change
    create_table :orders, id: :uuid do |t|
      t.references :user, null: false, type: :uuid, foreign_key: true
      t.references :event, null: false, type: :uuid, foreign_key: true, index: false
      t.string :number, null: false
      t.string :status, null: false, default: "paid"
      t.integer :subtotal_cents, null: false
      t.integer :discount_cents, null: false, default: 0
      t.integer :total_cents, null: false
      t.string :payment_reference
      t.datetime :refunded_at

      t.timestamps
    end

    add_index :orders, :number, unique: true
    add_index :orders, [ :event_id, :status ]
    add_check_constraint :orders, "status IN ('paid', 'refunded')", name: "orders_status_valid"
    add_check_constraint :orders, "subtotal_cents >= 0 AND discount_cents >= 0 AND total_cents >= 0",
      name: "orders_amounts_nonnegative"
    add_check_constraint :orders, "total_cents = subtotal_cents - discount_cents", name: "orders_total_matches"

    create_table :tickets, id: :uuid do |t|
      t.references :order, null: false, type: :uuid, foreign_key: true
      t.references :ticket_tier, null: false, type: :uuid, foreign_key: true
      t.string :code, null: false
      t.string :status, null: false, default: "valid"

      t.timestamps
    end

    add_index :tickets, :code, unique: true
    add_check_constraint :tickets, "status IN ('valid', 'void')", name: "tickets_status_valid"

    add_reference :holds, :order, type: :uuid, foreign_key: true, index: { unique: true }
  end
end
