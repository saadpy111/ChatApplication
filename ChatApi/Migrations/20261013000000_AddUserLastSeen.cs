using ChatApi.Data;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ChatApi.Migrations;

[DbContext(typeof(ApplicationDbContext))]
[Migration("20261013000000_AddUserLastSeen")]
public partial class AddUserLastSeen : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.AddColumn<DateTime>(
            name: "LastSeenAt",
            table: "AspNetUsers",
            type: "datetime2",
            nullable: true);
    }

    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.DropColumn(
            name: "LastSeenAt",
            table: "AspNetUsers");
    }
}