using Billing.Core.Data;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Billing.Core.Migrations
{
    [DbContext(typeof(BillingDbContext))]
    [Migration("20261115000000_IndexPendingDeliveriesByObject")]
    public partial class IndexPendingDeliveriesByObject : Migration
    {
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql(
                """
                CREATE INDEX ix_webhook_deliveries_pending_object ON webhook_deliveries (object_id, sequence) WHERE status = 'pending';
                """);
        }

        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql("DROP INDEX ix_webhook_deliveries_pending_object;");
        }
    }
}
