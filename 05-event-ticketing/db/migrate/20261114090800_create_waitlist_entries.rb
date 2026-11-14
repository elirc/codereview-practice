class CreateWaitlistEntries < ActiveRecord::Migration[8.0]
  def change
    create_table :waitlist_entries, id: :uuid do |t|
      t.references :user, null: false, type: :uuid, foreign_key: true
      t.references :ticket_tier, null: false, type: :uuid, foreign_key: true, index: false
      t.integer :quantity, null: false
      t.string :status, null: false, default: "waiting"
      t.datetime :offered_at
      t.datetime :offer_expires_at

      t.timestamps
    end

    add_index :waitlist_entries, [ :ticket_tier_id, :status, :created_at, :id ],
      name: "index_waitlist_entries_for_promotion"
    add_index :waitlist_entries, [ :user_id, :ticket_tier_id ], unique: true,
      where: "status IN ('waiting', 'offered')", name: "index_waitlist_entries_one_open_per_user_and_tier"
    add_check_constraint :waitlist_entries, "quantity > 0", name: "waitlist_entries_quantity_positive"
    add_check_constraint :waitlist_entries,
      "status IN ('waiting', 'offered', 'converted', 'expired', 'cancelled')", name: "waitlist_entries_status_valid"

    add_reference :holds, :waitlist_entry, type: :uuid, foreign_key: true, index: { unique: true }
  end
end
