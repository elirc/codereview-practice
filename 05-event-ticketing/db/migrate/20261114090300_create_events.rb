class CreateEvents < ActiveRecord::Migration[8.0]
  def change
    create_table :events, id: :uuid do |t|
      t.references :organizer, null: false, type: :uuid, foreign_key: { to_table: :users }
      t.string :title, null: false
      t.text :description
      t.string :venue, null: false
      t.string :time_zone, null: false
      t.datetime :starts_at, null: false
      t.datetime :ends_at, null: false
      t.datetime :sales_close_at, null: false
      t.string :status, null: false, default: "draft"

      t.timestamps
    end

    add_index :events, [ :status, :starts_at ]
    add_check_constraint :events, "status IN ('draft', 'published', 'cancelled')", name: "events_status_valid"
    add_check_constraint :events, "ends_at > starts_at", name: "events_ends_after_start"
  end
end
