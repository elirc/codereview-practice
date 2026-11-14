# This file is auto-generated from the current state of the database. Instead
# of editing this file, please use the migrations feature of Active Record to
# incrementally modify your database, and then regenerate this schema definition.
#
# This file is the source Rails uses to define your schema when running `bin/rails
# db:schema:load`. When creating a new database, `bin/rails db:schema:load` tends to
# be faster and is potentially less error prone than running all of your
# migrations from scratch. Old migrations may fail to apply correctly if those
# migrations use external dependencies or application code.
#
# It's strongly recommended that you check this file into your version control system.

ActiveRecord::Schema[8.0].define(version: 2026_11_14_090500) do
  # These are extensions that must be enabled in order to support this database
  enable_extension "pg_catalog.plpgsql"

  create_table "events", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.uuid "organizer_id", null: false
    t.string "title", null: false
    t.text "description"
    t.string "venue", null: false
    t.string "time_zone", null: false
    t.datetime "starts_at", null: false
    t.datetime "ends_at", null: false
    t.datetime "sales_close_at", null: false
    t.string "status", default: "draft", null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["organizer_id"], name: "index_events_on_organizer_id"
    t.index ["status", "starts_at"], name: "index_events_on_status_and_starts_at"
    t.check_constraint "(ends_at > starts_at)", name: "events_ends_after_start"
    t.check_constraint "((status)::text = ANY ((ARRAY['draft'::character varying, 'published'::character varying, 'cancelled'::character varying])::text[]))", name: "events_status_valid"
  end

  create_table "holds", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.uuid "user_id", null: false
    t.uuid "ticket_tier_id", null: false
    t.integer "quantity", null: false
    t.integer "unit_price_cents", null: false
    t.string "status", default: "active", null: false
    t.string "source", default: "direct", null: false
    t.datetime "expires_at", null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["status", "expires_at"], name: "index_holds_on_status_and_expires_at"
    t.index ["ticket_tier_id"], name: "index_holds_on_ticket_tier_id"
    t.index ["user_id"], name: "index_holds_on_user_id"
    t.index ["user_id", "ticket_tier_id"], name: "index_holds_one_active_per_user_and_tier", unique: true, where: "((status)::text = 'active'::text)"
    t.check_constraint "(quantity > 0)", name: "holds_quantity_positive"
    t.check_constraint "((source)::text = ANY ((ARRAY['direct'::character varying, 'waitlist'::character varying])::text[]))", name: "holds_source_valid"
    t.check_constraint "((status)::text = ANY ((ARRAY['active'::character varying, 'converted'::character varying, 'released'::character varying, 'expired'::character varying])::text[]))", name: "holds_status_valid"
    t.check_constraint "(unit_price_cents >= 0)", name: "holds_unit_price_nonnegative"
  end

  create_table "sessions", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.uuid "user_id", null: false
    t.string "ip_address"
    t.string "user_agent"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["user_id"], name: "index_sessions_on_user_id"
  end

  create_table "solid_queue_blocked_executions", force: :cascade do |t|
    t.bigint "job_id", null: false
    t.string "queue_name", null: false
    t.integer "priority", default: 0, null: false
    t.string "concurrency_key", null: false
    t.datetime "expires_at", null: false
    t.datetime "created_at", null: false
    t.index ["expires_at", "concurrency_key"], name: "index_solid_queue_blocked_executions_for_maintenance"
    t.index ["concurrency_key", "priority", "job_id"], name: "index_solid_queue_blocked_executions_for_release"
    t.index ["job_id"], name: "index_solid_queue_blocked_executions_on_job_id", unique: true
  end

  create_table "solid_queue_claimed_executions", force: :cascade do |t|
    t.bigint "job_id", null: false
    t.bigint "process_id"
    t.datetime "created_at", null: false
    t.index ["job_id"], name: "index_solid_queue_claimed_executions_on_job_id", unique: true
    t.index ["process_id", "job_id"], name: "index_solid_queue_claimed_executions_on_process_id_and_job_id"
  end

  create_table "solid_queue_failed_executions", force: :cascade do |t|
    t.bigint "job_id", null: false
    t.text "error"
    t.datetime "created_at", null: false
    t.index ["job_id"], name: "index_solid_queue_failed_executions_on_job_id", unique: true
  end

  create_table "solid_queue_jobs", force: :cascade do |t|
    t.string "queue_name", null: false
    t.string "class_name", null: false
    t.text "arguments"
    t.integer "priority", default: 0, null: false
    t.string "active_job_id"
    t.datetime "scheduled_at"
    t.datetime "finished_at"
    t.string "concurrency_key"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["scheduled_at", "finished_at"], name: "index_solid_queue_jobs_for_alerting"
    t.index ["queue_name", "finished_at"], name: "index_solid_queue_jobs_for_filtering"
    t.index ["active_job_id"], name: "index_solid_queue_jobs_on_active_job_id"
    t.index ["class_name"], name: "index_solid_queue_jobs_on_class_name"
    t.index ["finished_at"], name: "index_solid_queue_jobs_on_finished_at"
  end

  create_table "solid_queue_pauses", force: :cascade do |t|
    t.string "queue_name", null: false
    t.datetime "created_at", null: false
    t.index ["queue_name"], name: "index_solid_queue_pauses_on_queue_name", unique: true
  end

  create_table "solid_queue_processes", force: :cascade do |t|
    t.string "kind", null: false
    t.datetime "last_heartbeat_at", null: false
    t.bigint "supervisor_id"
    t.integer "pid", null: false
    t.string "hostname"
    t.text "metadata"
    t.datetime "created_at", null: false
    t.string "name", null: false
    t.index ["last_heartbeat_at"], name: "index_solid_queue_processes_on_last_heartbeat_at"
    t.index ["name", "supervisor_id"], name: "index_solid_queue_processes_on_name_and_supervisor_id", unique: true
    t.index ["supervisor_id"], name: "index_solid_queue_processes_on_supervisor_id"
  end

  create_table "solid_queue_ready_executions", force: :cascade do |t|
    t.bigint "job_id", null: false
    t.string "queue_name", null: false
    t.integer "priority", default: 0, null: false
    t.datetime "created_at", null: false
    t.index ["priority", "job_id"], name: "index_solid_queue_poll_all"
    t.index ["queue_name", "priority", "job_id"], name: "index_solid_queue_poll_by_queue"
    t.index ["job_id"], name: "index_solid_queue_ready_executions_on_job_id", unique: true
  end

  create_table "solid_queue_recurring_executions", force: :cascade do |t|
    t.bigint "job_id", null: false
    t.string "task_key", null: false
    t.datetime "run_at", null: false
    t.datetime "created_at", null: false
    t.index ["job_id"], name: "index_solid_queue_recurring_executions_on_job_id", unique: true
    t.index ["task_key", "run_at"], name: "index_solid_queue_recurring_executions_on_task_key_and_run_at", unique: true
  end

  create_table "solid_queue_recurring_tasks", force: :cascade do |t|
    t.string "key", null: false
    t.string "schedule", null: false
    t.string "command", limit: 2048
    t.string "class_name"
    t.text "arguments"
    t.string "queue_name"
    t.integer "priority", default: 0
    t.boolean "static", default: true, null: false
    t.text "description"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["key"], name: "index_solid_queue_recurring_tasks_on_key", unique: true
    t.index ["static"], name: "index_solid_queue_recurring_tasks_on_static"
  end

  create_table "solid_queue_scheduled_executions", force: :cascade do |t|
    t.bigint "job_id", null: false
    t.string "queue_name", null: false
    t.integer "priority", default: 0, null: false
    t.datetime "scheduled_at", null: false
    t.datetime "created_at", null: false
    t.index ["scheduled_at", "priority", "job_id"], name: "index_solid_queue_dispatch_all"
    t.index ["job_id"], name: "index_solid_queue_scheduled_executions_on_job_id", unique: true
  end

  create_table "solid_queue_semaphores", force: :cascade do |t|
    t.string "key", null: false
    t.integer "value", default: 1, null: false
    t.datetime "expires_at", null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["expires_at"], name: "index_solid_queue_semaphores_on_expires_at"
    t.index ["key"], name: "index_solid_queue_semaphores_on_key", unique: true
    t.index ["key", "value"], name: "index_solid_queue_semaphores_on_key_and_value"
  end

  create_table "ticket_tiers", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.uuid "event_id", null: false
    t.string "name", null: false
    t.integer "price_cents", null: false
    t.integer "capacity", null: false
    t.integer "sold_count", default: 0, null: false
    t.integer "held_count", default: 0, null: false
    t.integer "per_order_limit", default: 6, null: false
    t.integer "position", default: 0, null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["event_id", "position"], name: "index_ticket_tiers_on_event_id_and_position"
    t.check_constraint "(capacity >= 0)", name: "ticket_tiers_capacity_nonnegative"
    t.check_constraint "((sold_count + held_count) <= capacity)", name: "ticket_tiers_committed_within_capacity"
    t.check_constraint "(held_count >= 0)", name: "ticket_tiers_held_count_nonnegative"
    t.check_constraint "(per_order_limit > 0)", name: "ticket_tiers_per_order_limit_positive"
    t.check_constraint "(price_cents >= 0)", name: "ticket_tiers_price_nonnegative"
    t.check_constraint "(sold_count >= 0)", name: "ticket_tiers_sold_count_nonnegative"
  end

  create_table "users", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.string "email_address", null: false
    t.string "password_digest", null: false
    t.string "name", null: false
    t.string "role", default: "customer", null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["email_address"], name: "index_users_on_email_address", unique: true
    t.check_constraint "((role)::text = ANY ((ARRAY['customer'::character varying, 'organizer'::character varying, 'admin'::character varying])::text[]))", name: "users_role_valid"
  end

  add_foreign_key "events", "users", column: "organizer_id"
  add_foreign_key "holds", "ticket_tiers"
  add_foreign_key "holds", "users"
  add_foreign_key "sessions", "users"
  add_foreign_key "solid_queue_blocked_executions", "solid_queue_jobs", column: "job_id", on_delete: :cascade
  add_foreign_key "solid_queue_claimed_executions", "solid_queue_jobs", column: "job_id", on_delete: :cascade
  add_foreign_key "solid_queue_failed_executions", "solid_queue_jobs", column: "job_id", on_delete: :cascade
  add_foreign_key "solid_queue_ready_executions", "solid_queue_jobs", column: "job_id", on_delete: :cascade
  add_foreign_key "solid_queue_recurring_executions", "solid_queue_jobs", column: "job_id", on_delete: :cascade
  add_foreign_key "solid_queue_scheduled_executions", "solid_queue_jobs", column: "job_id", on_delete: :cascade
  add_foreign_key "ticket_tiers", "events"
end
