using Billing.Core.Data;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using Npgsql.EntityFrameworkCore.PostgreSQL.Metadata;

#nullable disable

namespace Billing.Core.Migrations
{
    [DbContext(typeof(BillingDbContext))]
    [Migration("20261101000000_InitialSchema")]
    public partial class InitialSchema : Migration
    {
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql("CREATE EXTENSION IF NOT EXISTS btree_gist;");

            migrationBuilder.CreateTable(
                name: "api_keys",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    name = table.Column<string>(type: "text", nullable: false),
                    key_hash = table.Column<string>(type: "text", nullable: false),
                    role = table.Column<string>(type: "text", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    revoked_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_api_keys", x => x.id);
                });

            migrationBuilder.CreateTable(
                name: "counters",
                columns: table => new
                {
                    name = table.Column<string>(type: "text", nullable: false),
                    year = table.Column<int>(type: "integer", nullable: false),
                    next = table.Column<long>(type: "bigint", nullable: false),
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_counters", x => new { x.name, x.year });
                });

            migrationBuilder.CreateTable(
                name: "customers",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    external_id = table.Column<string>(type: "text", nullable: false),
                    name = table.Column<string>(type: "text", nullable: false),
                    email = table.Column<string>(type: "text", nullable: false),
                    currency = table.Column<string>(type: "text", nullable: false),
                    timezone = table.Column<string>(type: "text", nullable: false),
                    country = table.Column<string>(type: "text", nullable: false),
                    region = table.Column<string>(type: "text", nullable: true),
                    tax_exempt = table.Column<bool>(type: "boolean", nullable: false),
                    payment_method_token = table.Column<string>(type: "text", nullable: true),
                    credit_balance_minor = table.Column<long>(type: "bigint", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_customers", x => x.id);
                });

            migrationBuilder.CreateTable(
                name: "meters",
                columns: table => new
                {
                    code = table.Column<string>(type: "text", nullable: false),
                    name = table.Column<string>(type: "text", nullable: false),
                    aggregation = table.Column<string>(type: "text", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_meters", x => x.code);
                });

            migrationBuilder.CreateTable(
                name: "products",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    name = table.Column<string>(type: "text", nullable: false),
                    active = table.Column<bool>(type: "boolean", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_products", x => x.id);
                });

            migrationBuilder.CreateTable(
                name: "tax_rates",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    country = table.Column<string>(type: "text", nullable: false),
                    region = table.Column<string>(type: "text", nullable: true),
                    rate_bps = table.Column<int>(type: "integer", nullable: false),
                    valid_from = table.Column<DateOnly>(type: "date", nullable: false),
                    valid_to = table.Column<DateOnly>(type: "date", nullable: true),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_tax_rates", x => x.id);
                });

            migrationBuilder.CreateTable(
                name: "webhook_endpoints",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    url = table.Column<string>(type: "text", nullable: false),
                    secret = table.Column<string>(type: "text", nullable: false),
                    previous_secret = table.Column<string>(type: "text", nullable: true),
                    previous_secret_expires_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    event_types = table.Column<string[]>(type: "text[]", nullable: false),
                    status = table.Column<string>(type: "text", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_webhook_endpoints", x => x.id);
                });

            migrationBuilder.CreateTable(
                name: "webhook_events",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    sequence = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    type = table.Column<string>(type: "text", nullable: false),
                    object_type = table.Column<string>(type: "text", nullable: false),
                    object_id = table.Column<Guid>(type: "uuid", nullable: false),
                    body = table.Column<string>(type: "text", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    fanned_out_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_webhook_events", x => x.id);
                });

            migrationBuilder.CreateTable(
                name: "idempotency_records",
                columns: table => new
                {
                    key_id = table.Column<Guid>(type: "uuid", nullable: false),
                    key = table.Column<string>(type: "text", nullable: false),
                    request_hash = table.Column<string>(type: "text", nullable: false),
                    response_status = table.Column<int>(type: "integer", nullable: false),
                    response_body = table.Column<string>(type: "text", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_idempotency_records", x => new { x.key_id, x.key });
                    table.ForeignKey(
                        name: "fk_idempotency_records_api_keys_key_id",
                        column: x => x.key_id,
                        principalTable: "api_keys",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "plans",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    product_id = table.Column<Guid>(type: "uuid", nullable: false),
                    code = table.Column<string>(type: "text", nullable: false),
                    name = table.Column<string>(type: "text", nullable: false),
                    interval = table.Column<string>(type: "text", nullable: false),
                    currency = table.Column<string>(type: "text", nullable: false),
                    trial_days = table.Column<int>(type: "integer", nullable: false),
                    active = table.Column<bool>(type: "boolean", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_plans", x => x.id);
                    table.ForeignKey(
                        name: "fk_plans_products_product_id",
                        column: x => x.product_id,
                        principalTable: "products",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "webhook_deliveries",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    event_id = table.Column<Guid>(type: "uuid", nullable: false),
                    endpoint_id = table.Column<Guid>(type: "uuid", nullable: false),
                    object_id = table.Column<Guid>(type: "uuid", nullable: false),
                    sequence = table.Column<long>(type: "bigint", nullable: false),
                    status = table.Column<string>(type: "text", nullable: false),
                    attempts = table.Column<int>(type: "integer", nullable: false),
                    next_attempt_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    last_status_code = table.Column<int>(type: "integer", nullable: true),
                    last_error = table.Column<string>(type: "text", nullable: true),
                    delivered_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_webhook_deliveries", x => x.id);
                    table.ForeignKey(
                        name: "fk_webhook_deliveries_webhook_endpoints_endpoint_id",
                        column: x => x.endpoint_id,
                        principalTable: "webhook_endpoints",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "fk_webhook_deliveries_webhook_events_event_id",
                        column: x => x.event_id,
                        principalTable: "webhook_events",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "plan_items",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    plan_id = table.Column<Guid>(type: "uuid", nullable: false),
                    position = table.Column<int>(type: "integer", nullable: false),
                    kind = table.Column<string>(type: "text", nullable: false),
                    name = table.Column<string>(type: "text", nullable: false),
                    unit_amount_minor = table.Column<long>(type: "bigint", nullable: true),
                    meter_code = table.Column<string>(type: "text", nullable: true),
                    tier_mode = table.Column<string>(type: "text", nullable: true),
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_plan_items", x => x.id);
                    table.ForeignKey(
                        name: "fk_plan_items_meters_meter_code",
                        column: x => x.meter_code,
                        principalTable: "meters",
                        principalColumn: "code",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "fk_plan_items_plans_plan_id",
                        column: x => x.plan_id,
                        principalTable: "plans",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "subscriptions",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    customer_id = table.Column<Guid>(type: "uuid", nullable: false),
                    product_id = table.Column<Guid>(type: "uuid", nullable: false),
                    plan_id = table.Column<Guid>(type: "uuid", nullable: false),
                    status = table.Column<string>(type: "text", nullable: false),
                    quantity = table.Column<int>(type: "integer", nullable: false),
                    anchor_date = table.Column<DateOnly>(type: "date", nullable: false),
                    period_index = table.Column<int>(type: "integer", nullable: false),
                    current_period_start = table.Column<DateOnly>(type: "date", nullable: true),
                    current_period_end = table.Column<DateOnly>(type: "date", nullable: true),
                    trial_ends_on = table.Column<DateOnly>(type: "date", nullable: true),
                    next_billing_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    pending_plan_id = table.Column<Guid>(type: "uuid", nullable: true),
                    pending_quantity = table.Column<int>(type: "integer", nullable: true),
                    cancel_at_period_end = table.Column<bool>(type: "boolean", nullable: false),
                    canceled_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    cancel_reason = table.Column<string>(type: "text", nullable: true),
                    ended_on = table.Column<DateOnly>(type: "date", nullable: true),
                    final_sealed_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_subscriptions", x => x.id);
                    table.ForeignKey(
                        name: "fk_subscriptions_customers_customer_id",
                        column: x => x.customer_id,
                        principalTable: "customers",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "fk_subscriptions_plans_pending_plan_id",
                        column: x => x.pending_plan_id,
                        principalTable: "plans",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "fk_subscriptions_plans_plan_id",
                        column: x => x.plan_id,
                        principalTable: "plans",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "fk_subscriptions_products_product_id",
                        column: x => x.product_id,
                        principalTable: "products",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "price_tiers",
                columns: table => new
                {
                    plan_item_id = table.Column<Guid>(type: "uuid", nullable: false),
                    position = table.Column<int>(type: "integer", nullable: false),
                    up_to = table.Column<long>(type: "bigint", nullable: true),
                    unit_amount_minor = table.Column<long>(type: "bigint", nullable: false),
                    flat_amount_minor = table.Column<long>(type: "bigint", nullable: false),
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_price_tiers", x => new { x.plan_item_id, x.position });
                    table.ForeignKey(
                        name: "fk_price_tiers_plan_items_plan_item_id",
                        column: x => x.plan_item_id,
                        principalTable: "plan_items",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "invoices",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    number = table.Column<string>(type: "text", nullable: true),
                    customer_id = table.Column<Guid>(type: "uuid", nullable: false),
                    subscription_id = table.Column<Guid>(type: "uuid", nullable: true),
                    kind = table.Column<string>(type: "text", nullable: false),
                    period_start = table.Column<DateOnly>(type: "date", nullable: true),
                    period_end = table.Column<DateOnly>(type: "date", nullable: true),
                    status = table.Column<string>(type: "text", nullable: false),
                    currency = table.Column<string>(type: "text", nullable: false),
                    subtotal_minor = table.Column<long>(type: "bigint", nullable: false),
                    tax_minor = table.Column<long>(type: "bigint", nullable: false),
                    total_minor = table.Column<long>(type: "bigint", nullable: false),
                    credit_applied_minor = table.Column<long>(type: "bigint", nullable: false),
                    amount_due_minor = table.Column<long>(type: "bigint", nullable: false),
                    amount_paid_minor = table.Column<long>(type: "bigint", nullable: false),
                    credited_minor = table.Column<long>(type: "bigint", nullable: false),
                    refunded_minor = table.Column<long>(type: "bigint", nullable: false),
                    amount_remaining_minor = table.Column<long>(type: "bigint", nullable: false),
                    issue_date = table.Column<DateOnly>(type: "date", nullable: true),
                    finalized_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    paid_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    bill_to_name = table.Column<string>(type: "text", nullable: true),
                    bill_to_email = table.Column<string>(type: "text", nullable: true),
                    bill_to_country = table.Column<string>(type: "text", nullable: true),
                    bill_to_region = table.Column<string>(type: "text", nullable: true),
                    bill_to_tax_exempt = table.Column<bool>(type: "boolean", nullable: false),
                    decline_count = table.Column<int>(type: "integer", nullable: false),
                    attempt_count = table.Column<int>(type: "integer", nullable: false),
                    next_payment_attempt_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_invoices", x => x.id);
                    table.ForeignKey(
                        name: "fk_invoices_customers_customer_id",
                        column: x => x.customer_id,
                        principalTable: "customers",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "fk_invoices_subscriptions_subscription_id",
                        column: x => x.subscription_id,
                        principalTable: "subscriptions",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "subscription_periods",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    subscription_id = table.Column<Guid>(type: "uuid", nullable: false),
                    index = table.Column<int>(type: "integer", nullable: false),
                    period_start = table.Column<DateOnly>(type: "date", nullable: false),
                    period_end = table.Column<DateOnly>(type: "date", nullable: false),
                    plan_id = table.Column<Guid>(type: "uuid", nullable: false),
                    usage_sealed_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_subscription_periods", x => x.id);
                    table.ForeignKey(
                        name: "fk_subscription_periods_plans_plan_id",
                        column: x => x.plan_id,
                        principalTable: "plans",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "fk_subscription_periods_subscriptions_subscription_id",
                        column: x => x.subscription_id,
                        principalTable: "subscriptions",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "credit_notes",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    number = table.Column<string>(type: "text", nullable: false),
                    invoice_id = table.Column<Guid>(type: "uuid", nullable: false),
                    reason = table.Column<string>(type: "text", nullable: false),
                    disposition = table.Column<string>(type: "text", nullable: false),
                    subtotal_minor = table.Column<long>(type: "bigint", nullable: false),
                    tax_minor = table.Column<long>(type: "bigint", nullable: false),
                    total_minor = table.Column<long>(type: "bigint", nullable: false),
                    refund_status = table.Column<string>(type: "text", nullable: true),
                    refund_attempts = table.Column<int>(type: "integer", nullable: false),
                    created_by_key_id = table.Column<Guid>(type: "uuid", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_credit_notes", x => x.id);
                    table.ForeignKey(
                        name: "fk_credit_notes_api_keys_created_by_key_id",
                        column: x => x.created_by_key_id,
                        principalTable: "api_keys",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "fk_credit_notes_invoices_invoice_id",
                        column: x => x.invoice_id,
                        principalTable: "invoices",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "invoice_lines",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    invoice_id = table.Column<Guid>(type: "uuid", nullable: false),
                    line_no = table.Column<int>(type: "integer", nullable: false),
                    kind = table.Column<string>(type: "text", nullable: false),
                    description = table.Column<string>(type: "text", nullable: false),
                    plan_item_id = table.Column<Guid>(type: "uuid", nullable: true),
                    quantity = table.Column<long>(type: "bigint", nullable: false),
                    amount_minor = table.Column<long>(type: "bigint", nullable: false),
                    tax_rate_bps = table.Column<int>(type: "integer", nullable: false),
                    tax_minor = table.Column<long>(type: "bigint", nullable: false),
                    period_start = table.Column<DateOnly>(type: "date", nullable: true),
                    period_end = table.Column<DateOnly>(type: "date", nullable: true),
                    credited_minor = table.Column<long>(type: "bigint", nullable: false),
                    credited_tax_minor = table.Column<long>(type: "bigint", nullable: false),
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_invoice_lines", x => x.id);
                    table.ForeignKey(
                        name: "fk_invoice_lines_invoices_invoice_id",
                        column: x => x.invoice_id,
                        principalTable: "invoices",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "fk_invoice_lines_plan_items_plan_item_id",
                        column: x => x.plan_item_id,
                        principalTable: "plan_items",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "payment_attempts",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    invoice_id = table.Column<Guid>(type: "uuid", nullable: false),
                    attempt_no = table.Column<int>(type: "integer", nullable: false),
                    idempotency_key = table.Column<string>(type: "text", nullable: false),
                    amount_minor = table.Column<long>(type: "bigint", nullable: false),
                    status = table.Column<string>(type: "text", nullable: false),
                    gateway_charge_id = table.Column<string>(type: "text", nullable: true),
                    failure_code = table.Column<string>(type: "text", nullable: true),
                    counts_as_decline = table.Column<bool>(type: "boolean", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    completed_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_payment_attempts", x => x.id);
                    table.ForeignKey(
                        name: "fk_payment_attempts_invoices_invoice_id",
                        column: x => x.invoice_id,
                        principalTable: "invoices",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "usage_events",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    subscription_id = table.Column<Guid>(type: "uuid", nullable: false),
                    meter_code = table.Column<string>(type: "text", nullable: false),
                    event_key = table.Column<string>(type: "text", nullable: false),
                    quantity = table.Column<long>(type: "bigint", nullable: false),
                    occurred_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    received_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    billed_period_id = table.Column<Guid>(type: "uuid", nullable: true),
                    late = table.Column<bool>(type: "boolean", nullable: false),
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_usage_events", x => x.id);
                    table.ForeignKey(
                        name: "fk_usage_events_meters_meter_code",
                        column: x => x.meter_code,
                        principalTable: "meters",
                        principalColumn: "code",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "fk_usage_events_subscription_periods_billed_period_id",
                        column: x => x.billed_period_id,
                        principalTable: "subscription_periods",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "fk_usage_events_subscriptions_subscription_id",
                        column: x => x.subscription_id,
                        principalTable: "subscriptions",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "credit_balance_transactions",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    customer_id = table.Column<Guid>(type: "uuid", nullable: false),
                    amount_minor = table.Column<long>(type: "bigint", nullable: false),
                    kind = table.Column<string>(type: "text", nullable: false),
                    invoice_id = table.Column<Guid>(type: "uuid", nullable: true),
                    credit_note_id = table.Column<Guid>(type: "uuid", nullable: true),
                    description = table.Column<string>(type: "text", nullable: true),
                    balance_after_minor = table.Column<long>(type: "bigint", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_credit_balance_transactions", x => x.id);
                    table.ForeignKey(
                        name: "fk_credit_balance_transactions_credit_notes_credit_note_id",
                        column: x => x.credit_note_id,
                        principalTable: "credit_notes",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "fk_credit_balance_transactions_customers_customer_id",
                        column: x => x.customer_id,
                        principalTable: "customers",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "fk_credit_balance_transactions_invoices_invoice_id",
                        column: x => x.invoice_id,
                        principalTable: "invoices",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "credit_note_lines",
                columns: table => new
                {
                    credit_note_id = table.Column<Guid>(type: "uuid", nullable: false),
                    invoice_line_id = table.Column<Guid>(type: "uuid", nullable: false),
                    amount_minor = table.Column<long>(type: "bigint", nullable: false),
                    tax_minor = table.Column<long>(type: "bigint", nullable: false),
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_credit_note_lines", x => new { x.credit_note_id, x.invoice_line_id });
                    table.ForeignKey(
                        name: "fk_credit_note_lines_credit_notes_credit_note_id",
                        column: x => x.credit_note_id,
                        principalTable: "credit_notes",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "fk_credit_note_lines_invoice_lines_invoice_line_id",
                        column: x => x.invoice_line_id,
                        principalTable: "invoice_lines",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateIndex(name: "ux_api_keys_key_hash", table: "api_keys", column: "key_hash", unique: true);
            migrationBuilder.CreateIndex(name: "ix_credit_balance_transactions_credit_note_id", table: "credit_balance_transactions", column: "credit_note_id");
            migrationBuilder.CreateIndex(name: "ix_credit_balance_transactions_customer_id", table: "credit_balance_transactions", column: "customer_id");
            migrationBuilder.CreateIndex(name: "ix_credit_balance_transactions_invoice_id", table: "credit_balance_transactions", column: "invoice_id");
            migrationBuilder.CreateIndex(name: "ix_credit_note_lines_invoice_line_id", table: "credit_note_lines", column: "invoice_line_id");
            migrationBuilder.CreateIndex(name: "ix_credit_notes_created_by_key_id", table: "credit_notes", column: "created_by_key_id");
            migrationBuilder.CreateIndex(name: "ix_credit_notes_invoice_id", table: "credit_notes", column: "invoice_id");
            migrationBuilder.CreateIndex(name: "ux_credit_notes_number", table: "credit_notes", column: "number", unique: true);
            migrationBuilder.CreateIndex(name: "ux_customers_external_id", table: "customers", column: "external_id", unique: true);
            migrationBuilder.CreateIndex(name: "ix_idempotency_records_created_at", table: "idempotency_records", column: "created_at");
            migrationBuilder.CreateIndex(name: "ix_invoice_lines_plan_item_id", table: "invoice_lines", column: "plan_item_id");
            migrationBuilder.CreateIndex(name: "ux_invoice_lines_line_no", table: "invoice_lines", columns: new[] { "invoice_id", "line_no" }, unique: true);
            migrationBuilder.CreateIndex(name: "ix_invoices_customer_id", table: "invoices", column: "customer_id");
            migrationBuilder.CreateIndex(name: "ux_invoices_number", table: "invoices", column: "number", unique: true);
            migrationBuilder.CreateIndex(name: "ix_invoices_subscription_id", table: "invoices", column: "subscription_id");
            migrationBuilder.CreateIndex(name: "ux_payment_attempts_attempt_no", table: "payment_attempts", columns: new[] { "invoice_id", "attempt_no" }, unique: true);
            migrationBuilder.CreateIndex(name: "ux_payment_attempts_idempotency_key", table: "payment_attempts", column: "idempotency_key", unique: true);
            migrationBuilder.CreateIndex(name: "ix_plan_items_meter_code", table: "plan_items", column: "meter_code");
            migrationBuilder.CreateIndex(name: "ux_plan_items_position", table: "plan_items", columns: new[] { "plan_id", "position" }, unique: true);
            migrationBuilder.CreateIndex(name: "ux_plans_code", table: "plans", column: "code", unique: true);
            migrationBuilder.CreateIndex(name: "ix_plans_product_id", table: "plans", column: "product_id");
            migrationBuilder.CreateIndex(name: "ix_subscription_periods_plan_id", table: "subscription_periods", column: "plan_id");
            migrationBuilder.CreateIndex(name: "ux_subscription_periods_index", table: "subscription_periods", columns: new[] { "subscription_id", "index" }, unique: true);
            migrationBuilder.CreateIndex(name: "ix_subscriptions_customer_id", table: "subscriptions", column: "customer_id");
            migrationBuilder.CreateIndex(name: "ix_subscriptions_next_billing_at", table: "subscriptions", column: "next_billing_at");
            migrationBuilder.CreateIndex(name: "ix_subscriptions_pending_plan_id", table: "subscriptions", column: "pending_plan_id");
            migrationBuilder.CreateIndex(name: "ix_subscriptions_plan_id", table: "subscriptions", column: "plan_id");
            migrationBuilder.CreateIndex(name: "ix_subscriptions_product_id", table: "subscriptions", column: "product_id");
            migrationBuilder.CreateIndex(name: "ix_tax_rates_country_region", table: "tax_rates", columns: new[] { "country", "region" });
            migrationBuilder.CreateIndex(name: "ix_usage_events_billed_period_id", table: "usage_events", column: "billed_period_id");
            migrationBuilder.CreateIndex(name: "ix_usage_events_meter_code", table: "usage_events", column: "meter_code");
            migrationBuilder.CreateIndex(name: "ux_usage_events_key", table: "usage_events", columns: new[] { "subscription_id", "event_key" }, unique: true);
            migrationBuilder.CreateIndex(name: "ix_webhook_deliveries_endpoint_object", table: "webhook_deliveries", columns: new[] { "endpoint_id", "object_id", "sequence" });
            migrationBuilder.CreateIndex(name: "ux_webhook_deliveries_event_endpoint", table: "webhook_deliveries", columns: new[] { "event_id", "endpoint_id" }, unique: true);
            migrationBuilder.CreateIndex(name: "ux_webhook_events_sequence", table: "webhook_events", column: "sequence", unique: true);

            migrationBuilder.Sql(
                """
                ALTER TABLE customers ADD CONSTRAINT ck_customers_credit_balance CHECK (credit_balance_minor >= 0);
                ALTER TABLE plans ADD CONSTRAINT ck_plans_trial_days CHECK (trial_days BETWEEN 0 AND 90);
                ALTER TABLE subscriptions ADD CONSTRAINT ck_subscriptions_quantity CHECK (quantity >= 1);
                ALTER TABLE subscriptions ADD CONSTRAINT ck_subscriptions_pending_quantity CHECK (pending_quantity IS NULL OR pending_quantity >= 1);
                ALTER TABLE usage_events ADD CONSTRAINT ck_usage_events_quantity CHECK (quantity > 0);
                ALTER TABLE invoices ADD CONSTRAINT ck_invoices_amount_remaining CHECK (amount_remaining_minor >= 0);
                ALTER TABLE invoice_lines ADD CONSTRAINT ck_invoice_lines_credited CHECK (amount_minor <= 0 OR credited_minor <= amount_minor);
                ALTER TABLE tax_rates ADD CONSTRAINT ck_tax_rates_rate CHECK (rate_bps BETWEEN 0 AND 5000);
                ALTER TABLE tax_rates ADD CONSTRAINT ck_tax_rates_range CHECK (valid_to IS NULL OR valid_to > valid_from);
                """);

            migrationBuilder.Sql(
                """
                ALTER TABLE tax_rates ADD CONSTRAINT ex_tax_rates_no_overlap EXCLUDE USING gist (
                    country WITH =,
                    (coalesce(region, '')) WITH =,
                    daterange(valid_from, valid_to, '[)') WITH &&
                );
                """);

            migrationBuilder.Sql(
                """
                CREATE UNIQUE INDEX ux_subscriptions_live ON subscriptions (customer_id, product_id) WHERE status <> 'canceled';
                CREATE UNIQUE INDEX ux_invoices_cycle_period ON invoices (subscription_id, period_start) WHERE kind = 'cycle';
                CREATE UNIQUE INDEX ux_invoices_final ON invoices (subscription_id) WHERE kind = 'final';
                CREATE UNIQUE INDEX ux_payment_attempts_in_flight ON payment_attempts (invoice_id) WHERE status IN ('pending', 'unknown');
                CREATE UNIQUE INDEX ux_plan_items_one_seat ON plan_items (plan_id) WHERE kind = 'per_seat';
                CREATE UNIQUE INDEX ux_plan_items_meter ON plan_items (plan_id, meter_code) WHERE kind = 'usage';
                CREATE INDEX ix_usage_events_unbilled ON usage_events (subscription_id, occurred_at) WHERE billed_period_id IS NULL;
                CREATE INDEX ix_invoices_payment_due ON invoices (next_payment_attempt_at) WHERE status = 'open';
                CREATE INDEX ix_credit_notes_refund_pending ON credit_notes (created_at) WHERE refund_status = 'pending';
                CREATE INDEX ix_webhook_events_unfanned ON webhook_events (sequence) WHERE fanned_out_at IS NULL;
                CREATE INDEX ix_webhook_deliveries_pending ON webhook_deliveries (next_attempt_at) WHERE status = 'pending';
                """);

            migrationBuilder.Sql(
                """
                CREATE FUNCTION invoices_guard_finalized() RETURNS trigger LANGUAGE plpgsql AS $$
                BEGIN
                    IF TG_OP = 'DELETE' THEN
                        IF OLD.status <> 'draft' THEN
                            RAISE EXCEPTION 'invoice % is finalized and cannot be deleted', OLD.id
                                USING ERRCODE = 'integrity_constraint_violation';
                        END IF;
                        RETURN OLD;
                    END IF;

                    IF OLD.status <> 'draft' AND
                       (to_jsonb(NEW) - ARRAY['status', 'amount_paid_minor', 'credited_minor', 'refunded_minor',
                                             'amount_remaining_minor', 'paid_at', 'decline_count', 'attempt_count',
                                             'next_payment_attempt_at'])
                       IS DISTINCT FROM
                       (to_jsonb(OLD) - ARRAY['status', 'amount_paid_minor', 'credited_minor', 'refunded_minor',
                                             'amount_remaining_minor', 'paid_at', 'decline_count', 'attempt_count',
                                             'next_payment_attempt_at']) THEN
                        RAISE EXCEPTION 'invoice % is finalized; only payment and credit columns may change', OLD.id
                            USING ERRCODE = 'integrity_constraint_violation';
                    END IF;

                    RETURN NEW;
                END;
                $$;

                CREATE TRIGGER invoices_guard_finalized
                    BEFORE UPDATE OR DELETE ON invoices
                    FOR EACH ROW EXECUTE FUNCTION invoices_guard_finalized();
                """);

            migrationBuilder.Sql(
                """
                CREATE FUNCTION invoice_lines_guard_finalized() RETURNS trigger LANGUAGE plpgsql AS $$
                DECLARE
                    old_parent_status text;
                    new_parent_status text;
                BEGIN
                    IF TG_OP IN ('UPDATE', 'DELETE') THEN
                        SELECT status INTO old_parent_status FROM invoices WHERE id = OLD.invoice_id;
                    END IF;
                    IF TG_OP IN ('UPDATE', 'INSERT') THEN
                        SELECT status INTO new_parent_status FROM invoices WHERE id = NEW.invoice_id;
                    END IF;

                    IF TG_OP = 'INSERT' THEN
                        IF new_parent_status IS NOT NULL AND new_parent_status <> 'draft' THEN
                            RAISE EXCEPTION 'invoice % is finalized; lines cannot be added', NEW.invoice_id
                                USING ERRCODE = 'integrity_constraint_violation';
                        END IF;
                        RETURN NEW;
                    END IF;

                    IF TG_OP = 'DELETE' THEN
                        IF old_parent_status IS NOT NULL AND old_parent_status <> 'draft' THEN
                            RAISE EXCEPTION 'invoice % is finalized; lines cannot be removed', OLD.invoice_id
                                USING ERRCODE = 'integrity_constraint_violation';
                        END IF;
                        RETURN OLD;
                    END IF;

                    IF (old_parent_status IS NOT NULL AND old_parent_status <> 'draft')
                       OR (new_parent_status IS NOT NULL AND new_parent_status <> 'draft') THEN
                        IF (to_jsonb(NEW) - ARRAY['credited_minor', 'credited_tax_minor'])
                           IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['credited_minor', 'credited_tax_minor']) THEN
                            RAISE EXCEPTION 'invoice % is finalized; only credited amounts of its lines may change', OLD.invoice_id
                                USING ERRCODE = 'integrity_constraint_violation';
                        END IF;
                    END IF;

                    RETURN NEW;
                END;
                $$;

                CREATE TRIGGER invoice_lines_guard_finalized
                    BEFORE INSERT OR UPDATE OR DELETE ON invoice_lines
                    FOR EACH ROW EXECUTE FUNCTION invoice_lines_guard_finalized();
                """);
        }

        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(name: "credit_note_lines");
            migrationBuilder.DropTable(name: "credit_balance_transactions");
            migrationBuilder.DropTable(name: "usage_events");
            migrationBuilder.DropTable(name: "payment_attempts");
            migrationBuilder.DropTable(name: "invoice_lines");
            migrationBuilder.DropTable(name: "credit_notes");
            migrationBuilder.DropTable(name: "subscription_periods");
            migrationBuilder.DropTable(name: "invoices");
            migrationBuilder.DropTable(name: "price_tiers");
            migrationBuilder.DropTable(name: "subscriptions");
            migrationBuilder.DropTable(name: "plan_items");
            migrationBuilder.DropTable(name: "webhook_deliveries");
            migrationBuilder.DropTable(name: "plans");
            migrationBuilder.DropTable(name: "idempotency_records");
            migrationBuilder.DropTable(name: "webhook_events");
            migrationBuilder.DropTable(name: "webhook_endpoints");
            migrationBuilder.DropTable(name: "tax_rates");
            migrationBuilder.DropTable(name: "products");
            migrationBuilder.DropTable(name: "meters");
            migrationBuilder.DropTable(name: "customers");
            migrationBuilder.DropTable(name: "counters");
            migrationBuilder.DropTable(name: "api_keys");
            migrationBuilder.Sql("DROP FUNCTION IF EXISTS invoice_lines_guard_finalized();");
            migrationBuilder.Sql("DROP FUNCTION IF EXISTS invoices_guard_finalized();");
        }
    }
}
