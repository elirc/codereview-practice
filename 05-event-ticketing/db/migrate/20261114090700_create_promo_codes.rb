class CreatePromoCodes < ActiveRecord::Migration[8.0]
  def change
    create_table :promo_codes, id: :uuid do |t|
      t.references :event, type: :uuid, foreign_key: true, index: false
      t.string :code, null: false
      t.string :kind, null: false
      t.integer :percent_off
      t.integer :amount_off_cents
      t.boolean :stackable, null: false, default: false
      t.integer :max_redemptions
      t.integer :redemptions_count, null: false, default: 0
      t.integer :per_user_limit, null: false, default: 1
      t.datetime :starts_at
      t.datetime :ends_at
      t.integer :min_subtotal_cents, null: false, default: 0
      t.boolean :active, null: false, default: true

      t.timestamps
    end

    add_index :promo_codes, [ :event_id, :code ], unique: true, where: "event_id IS NOT NULL"
    add_index :promo_codes, :code, unique: true, where: "event_id IS NULL", name: "index_promo_codes_site_wide_code"

    add_check_constraint :promo_codes, <<~SQL.squish, name: "promo_codes_discount_matches_kind"
      (kind = 'percent' AND percent_off >= 1 AND percent_off <= 100 AND amount_off_cents IS NULL)
      OR (kind = 'fixed' AND amount_off_cents > 0 AND percent_off IS NULL)
    SQL
    add_check_constraint :promo_codes, "per_user_limit > 0 AND (max_redemptions IS NULL OR max_redemptions > 0)",
      name: "promo_codes_limits_positive"
    add_check_constraint :promo_codes,
      "redemptions_count >= 0 AND (max_redemptions IS NULL OR redemptions_count <= max_redemptions)",
      name: "promo_codes_redemptions_within_max"
    add_check_constraint :promo_codes, "min_subtotal_cents >= 0", name: "promo_codes_min_subtotal_nonnegative"
    add_check_constraint :promo_codes, "starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at",
      name: "promo_codes_window_valid"

    create_table :promo_code_tiers, id: :uuid do |t|
      t.references :promo_code, null: false, type: :uuid, foreign_key: { on_delete: :cascade }, index: false
      t.references :ticket_tier, null: false, type: :uuid, foreign_key: { on_delete: :cascade }

      t.timestamps
    end

    add_index :promo_code_tiers, [ :promo_code_id, :ticket_tier_id ], unique: true

    create_table :hold_promos, id: :uuid do |t|
      t.references :hold, null: false, type: :uuid, foreign_key: true, index: false
      t.references :promo_code, null: false, type: :uuid, foreign_key: true

      t.timestamps
    end

    add_index :hold_promos, [ :hold_id, :promo_code_id ], unique: true

    create_table :promo_redemptions, id: :uuid do |t|
      t.references :promo_code, null: false, type: :uuid, foreign_key: true, index: false
      t.references :order, null: false, type: :uuid, foreign_key: true
      t.references :user, null: false, type: :uuid, foreign_key: true
      t.integer :amount_cents, null: false

      t.timestamps
    end

    add_index :promo_redemptions, [ :promo_code_id, :order_id ], unique: true
    add_index :promo_redemptions, [ :promo_code_id, :user_id ]
    add_check_constraint :promo_redemptions, "amount_cents >= 0", name: "promo_redemptions_amount_nonnegative"
  end
end
