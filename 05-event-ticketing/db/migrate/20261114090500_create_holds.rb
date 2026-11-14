class CreateHolds < ActiveRecord::Migration[8.0]
  def change
    create_table :holds, id: :uuid do |t|
      t.references :user, null: false, type: :uuid, foreign_key: true
      t.references :ticket_tier, null: false, type: :uuid, foreign_key: true
      t.integer :quantity, null: false
      t.integer :unit_price_cents, null: false
      t.string :status, null: false, default: "active"
      t.string :source, null: false, default: "direct"
      t.datetime :expires_at, null: false

      t.timestamps
    end

    add_index :holds, [ :user_id, :ticket_tier_id ], unique: true, where: "status = 'active'",
      name: "index_holds_one_active_per_user_and_tier"
    add_index :holds, [ :status, :expires_at ]

    add_check_constraint :holds, "quantity > 0", name: "holds_quantity_positive"
    add_check_constraint :holds, "unit_price_cents >= 0", name: "holds_unit_price_nonnegative"
    add_check_constraint :holds, "status IN ('active', 'converted', 'released', 'expired')", name: "holds_status_valid"
    add_check_constraint :holds, "source IN ('direct', 'waitlist')", name: "holds_source_valid"
  end
end
