using ChatApi.Models;
using Microsoft.AspNetCore.Identity.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore;

namespace ChatApi.Data;

public class ApplicationDbContext : IdentityDbContext<ApplicationUser>
{
    public ApplicationDbContext(DbContextOptions<ApplicationDbContext> options)
        : base(options)
    {
    }

    public DbSet<Conversation> Conversations => Set<Conversation>();
    public DbSet<Message> Messages => Set<Message>();
    public DbSet<MessageReaction> MessageReactions => Set<MessageReaction>();

    protected override void OnModelCreating(ModelBuilder builder)
    {
        base.OnModelCreating(builder);

        builder.Entity<Conversation>(entity =>
        {
            entity.ToTable(table => table.HasCheckConstraint(
                "CK_Conversations_DistinctParticipants",
                "[User1Id] < [User2Id]"));
            entity.HasKey(conversation => conversation.Id);
            entity.HasIndex(conversation => new { conversation.User1Id, conversation.User2Id })
                .IsUnique();
            entity.HasOne(conversation => conversation.User1)
                .WithMany()
                .HasForeignKey(conversation => conversation.User1Id)
                .OnDelete(DeleteBehavior.Restrict);
            entity.HasOne(conversation => conversation.User2)
                .WithMany()
                .HasForeignKey(conversation => conversation.User2Id)
                .OnDelete(DeleteBehavior.Restrict);
        });

        builder.Entity<Message>(entity =>
        {
            entity.HasKey(message => message.Id);
            entity.Property(message => message.Content).HasMaxLength(Message.MaxContentLength).IsRequired();
            entity.HasIndex(message => new { message.ConversationId, message.CreatedAt, message.Id });
            entity.HasOne(message => message.Conversation)
                .WithMany(conversation => conversation.Messages)
                .HasForeignKey(message => message.ConversationId)
                .OnDelete(DeleteBehavior.Restrict);
            entity.HasOne(message => message.Sender)
                .WithMany()
                .HasForeignKey(message => message.SenderId)
                .OnDelete(DeleteBehavior.Restrict);
        });

        builder.Entity<MessageReaction>(entity =>
        {
            entity.HasKey(r => r.Id);
            entity.Property(r => r.Emoji).HasMaxLength(16).IsRequired();
            entity.HasIndex(r => new { r.MessageId, r.UserId }).IsUnique();
            entity.HasIndex(r => r.MessageId);
            entity.HasOne(r => r.Message)
                .WithMany(m => m.Reactions)
                .HasForeignKey(r => r.MessageId)
                .OnDelete(DeleteBehavior.Cascade);
            entity.HasOne(r => r.User)
                .WithMany()
                .HasForeignKey(r => r.UserId)
                .OnDelete(DeleteBehavior.Restrict);
        });
    }
}