using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ChatApi.Migrations
{
    /// <inheritdoc />
    public partial class AddMessageEditDelete : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<DateTime>(
                name: "DeletedAt",
                table: "Messages",
                type: "datetime2",
                nullable: true);

            migrationBuilder.AddColumn<DateTime>(
                name: "EditedAt",
                table: "Messages",
                type: "datetime2",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "DeletedAt",
                table: "Messages");

            migrationBuilder.DropColumn(
                name: "EditedAt",
                table: "Messages");
        }
    }
}
