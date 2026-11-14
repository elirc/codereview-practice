using Billing.Core.Data;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Billing.Core.Migrations
{
    [DbContext(typeof(BillingDbContext))]
    [Migration("20261102000000_RejectInvoiceReturnToDraft")]
    public partial class RejectInvoiceReturnToDraft : Migration
    {
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql(
                """
                CREATE OR REPLACE FUNCTION invoices_guard_finalized() RETURNS trigger LANGUAGE plpgsql AS $$
                BEGIN
                    IF TG_OP = 'DELETE' THEN
                        IF OLD.status <> 'draft' THEN
                            RAISE EXCEPTION 'invoice % is finalized and cannot be deleted', OLD.id
                                USING ERRCODE = 'integrity_constraint_violation';
                        END IF;
                        RETURN OLD;
                    END IF;

                    IF OLD.status <> 'draft' AND NEW.status = 'draft' THEN
                        RAISE EXCEPTION 'invoice % is finalized and cannot return to draft', OLD.id
                            USING ERRCODE = 'integrity_constraint_violation';
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
                """);
        }

        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql(
                """
                CREATE OR REPLACE FUNCTION invoices_guard_finalized() RETURNS trigger LANGUAGE plpgsql AS $$
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
                """);
        }
    }
}
