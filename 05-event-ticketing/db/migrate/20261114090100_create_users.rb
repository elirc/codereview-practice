class CreateUsers < ActiveRecord::Migration[8.0]
  def change
    create_table :users, id: :uuid do |t|
      t.string :email_address, null: false
      t.string :password_digest, null: false
      t.string :name, null: false
      t.string :role, null: false, default: "customer"

      t.timestamps
    end

    add_index :users, :email_address, unique: true
    add_check_constraint :users, "role IN ('customer', 'organizer', 'admin')", name: "users_role_valid"
  end
end
