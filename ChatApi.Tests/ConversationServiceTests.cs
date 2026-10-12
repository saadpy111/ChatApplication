using ChatApi.Data;
using ChatApi.Models;
using ChatApi.Services.Conversations;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Identity.EntityFrameworkCore;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace ChatApi.Tests;

public sealed class ConversationServiceTests : IAsyncLifetime
{
    private readonly SqliteConnection _connection = new("Data Source=:memory:");
    private ApplicationDbContext _dbContext = null!;
    private ConversationService _service = null!;

    public async Task InitializeAsync()
    {
        await _connection.OpenAsync();
        var options = new DbContextOptionsBuilder<ApplicationDbContext>()
            .UseSqlite(_connection)
            .Options;
        _dbContext = new ApplicationDbContext(options);
        await _dbContext.Database.EnsureCreatedAsync();
        _dbContext.Users.AddRange(
            new ApplicationUser { Id = "user-a", UserName = "alice", NormalizedUserName = "ALICE" },
            new ApplicationUser { Id = "user-b", UserName = "bob", NormalizedUserName = "BOB" },
            new ApplicationUser { Id = "user-c", UserName = "cara", NormalizedUserName = "CARA" });
        await _dbContext.SaveChangesAsync();

        var userManager = new UserManager<ApplicationUser>(
            new UserStore<ApplicationUser>(_dbContext),
            Options.Create(new IdentityOptions()),
            new PasswordHasher<ApplicationUser>(),
            [new UserValidator<ApplicationUser>()],
            [new PasswordValidator<ApplicationUser>()],
            new UpperInvariantLookupNormalizer(),
            new IdentityErrorDescriber(),
            new ServiceCollection().BuildServiceProvider(),
            NullLogger<UserManager<ApplicationUser>>.Instance);
        _service = new ConversationService(_dbContext, userManager);
    }

    public async Task DisposeAsync()
    {
        await _dbContext.DisposeAsync();
        await _connection.DisposeAsync();
    }

    [Fact]
    public async Task OpenAsyncReturnsExistingConversationForEitherParticipantOrder()
    {
        var first = await _service.OpenAsync("user-a", "user-b", CancellationToken.None);
        var second = await _service.OpenAsync("user-b", "user-a", CancellationToken.None);

        Assert.NotNull(first);
        Assert.NotNull(second);
        Assert.Equal(first.ConversationId, second.ConversationId);
        Assert.Equal("user-b", first.UserId);
        Assert.Equal("bob", first.Username);
        Assert.Equal(1, await _dbContext.Conversations.CountAsync());
    }

    [Fact]
    public async Task DatabaseRejectsDuplicateAndSelfParticipantPairs()
    {
        await _service.OpenAsync("user-a", "user-b", CancellationToken.None);
        _dbContext.Conversations.Add(new Conversation
        {
            User1Id = "user-a",
            User2Id = "user-b",
            CreatedAt = DateTime.UtcNow
        });

        await Assert.ThrowsAsync<DbUpdateException>(() => _dbContext.SaveChangesAsync());
        _dbContext.ChangeTracker.Clear();
        _dbContext.Conversations.Add(new Conversation
        {
            User1Id = "user-a",
            User2Id = "user-a",
            CreatedAt = DateTime.UtcNow
        });

        await Assert.ThrowsAsync<DbUpdateException>(() => _dbContext.SaveChangesAsync());
    }

    [Fact]
    public async Task SendMessagePersistsAndRejectsNonParticipants()
    {
        var conversation = await _service.OpenAsync("user-a", "user-b", CancellationToken.None);
        Assert.NotNull(conversation);

        var sent = await _service.SendMessageAsync(
            conversation.ConversationId, "user-a", "hello", CancellationToken.None);
        var denied = await _service.SendMessageAsync(
            conversation.ConversationId, "user-c", "intrusion", CancellationToken.None);

        Assert.NotNull(sent);
        Assert.Null(denied);
        var stored = await _dbContext.Messages.SingleAsync();
        Assert.Equal(sent.Value.Message.Id, stored.Id);
        Assert.Equal("user-a", stored.SenderId);
        Assert.Equal("hello", stored.Content);
        Assert.Equal("user-b", sent.Value.RecipientId);
        Assert.Null(stored.DeliveredAt);
        Assert.Null(stored.ReadAt);
    }

    [Fact]
    public async Task GetConversationsReturnsUnreadIncomingCountsPerConversation()
    {
        var firstConversation = await _service.OpenAsync("user-a", "user-b", CancellationToken.None);
        var secondConversation = await _service.OpenAsync("user-a", "user-c", CancellationToken.None);
        Assert.NotNull(firstConversation);
        Assert.NotNull(secondConversation);

        _dbContext.Messages.AddRange(
            new Message
            {
                ConversationId = firstConversation.ConversationId,
                SenderId = "user-b",
                Content = "unread",
                CreatedAt = DateTime.UtcNow
            },
            new Message
            {
                ConversationId = firstConversation.ConversationId,
                SenderId = "user-b",
                Content = "delivered but unread",
                CreatedAt = DateTime.UtcNow.AddSeconds(1),
                DeliveredAt = DateTime.UtcNow.AddSeconds(2)
            },
            new Message
            {
                ConversationId = firstConversation.ConversationId,
                SenderId = "user-b",
                Content = "read",
                CreatedAt = DateTime.UtcNow.AddSeconds(3),
                ReadAt = DateTime.UtcNow.AddSeconds(4)
            },
            new Message
            {
                ConversationId = firstConversation.ConversationId,
                SenderId = "user-a",
                Content = "outgoing",
                CreatedAt = DateTime.UtcNow.AddSeconds(5)
            },
            new Message
            {
                ConversationId = secondConversation.ConversationId,
                SenderId = "user-a",
                Content = "other conversation outgoing",
                CreatedAt = DateTime.UtcNow.AddSeconds(6)
            });
        await _dbContext.SaveChangesAsync();

        var conversations = await _service.GetConversationsAsync("user-a", CancellationToken.None);
        var first = Assert.Single(conversations, item => item.ConversationId == firstConversation.ConversationId);
        var second = Assert.Single(conversations, item => item.ConversationId == secondConversation.ConversationId);
        var otherUserConversations = await _service.GetConversationsAsync("user-b", CancellationToken.None);

        Assert.Equal(2, first.UnreadCount);
        Assert.Equal(0, second.UnreadCount);
        Assert.Single(otherUserConversations);
        Assert.Equal(1, otherUserConversations[0].UnreadCount);
    }

    [Fact]
    public async Task DeliveryAcknowledgementIsRecipientOnlyAndIdempotent()
    {
        var conversation = await _service.OpenAsync("user-a", "user-b", CancellationToken.None);
        Assert.NotNull(conversation);
        var sent = await _service.SendMessageAsync(
            conversation.ConversationId, "user-a", "hello", CancellationToken.None);
        Assert.NotNull(sent);

        var deniedSender = await _service.MarkMessageAsDeliveredAsync(
            sent.Value.Message.Id, "user-a", CancellationToken.None);
        var deniedOutsider = await _service.MarkMessageAsDeliveredAsync(
            sent.Value.Message.Id, "user-c", CancellationToken.None);
        var delivered = await _service.MarkMessageAsDeliveredAsync(
            sent.Value.Message.Id, "user-b", CancellationToken.None);
        var deliveredAgain = await _service.MarkMessageAsDeliveredAsync(
            sent.Value.Message.Id, "user-b", CancellationToken.None);

        Assert.Null(deniedSender);
        Assert.Null(deniedOutsider);
        Assert.NotNull(delivered);
        Assert.NotNull(delivered.Value.Message.DeliveredAt);
        Assert.Null(delivered.Value.Message.ReadAt);
        Assert.Equal(delivered.Value.Message.DeliveredAt, deliveredAgain!.Value.Message.DeliveredAt);
        Assert.Equal(delivered.Value.Message.DeliveredAt, (await _dbContext.Messages.SingleAsync()).DeliveredAt);
    }

    [Fact]
    public async Task PendingDeliveryReconciliationMarksAllIncomingMessagesAcrossConversations()
    {
        var firstConversation = await _service.OpenAsync("user-a", "user-b", CancellationToken.None);
        var secondConversation = await _service.OpenAsync("user-a", "user-c", CancellationToken.None);
        Assert.NotNull(firstConversation);
        Assert.NotNull(secondConversation);

        var olderPending = new Message
        {
            ConversationId = firstConversation.ConversationId,
            SenderId = "user-b",
            Content = "older pending",
            CreatedAt = DateTime.UtcNow.AddMinutes(-3)
        };
        var newerDelivered = new Message
        {
            ConversationId = firstConversation.ConversationId,
            SenderId = "user-b",
            Content = "newer already delivered",
            CreatedAt = DateTime.UtcNow.AddMinutes(-2),
            DeliveredAt = DateTime.UtcNow.AddMinutes(-1)
        };
        var alreadyReadAt = DateTime.UtcNow.AddMinutes(-1);
        var alreadyRead = new Message
        {
            ConversationId = firstConversation.ConversationId,
            SenderId = "user-b",
            Content = "already read",
            CreatedAt = DateTime.UtcNow.AddMinutes(-1),
            DeliveredAt = alreadyReadAt.AddMinutes(-1),
            ReadAt = alreadyReadAt
        };
        var secondConversationPending = new Message
        {
            ConversationId = secondConversation.ConversationId,
            SenderId = "user-c",
            Content = "second conversation pending",
            CreatedAt = DateTime.UtcNow.AddMinutes(-1)
        };
        var outgoing = new Message
        {
            ConversationId = firstConversation.ConversationId,
            SenderId = "user-a",
            Content = "outgoing",
            CreatedAt = DateTime.UtcNow
        };
        _dbContext.Messages.AddRange(olderPending, newerDelivered, alreadyRead, secondConversationPending, outgoing);
        await _dbContext.SaveChangesAsync();

        var receipts = await _service.ReconcilePendingDeliveriesAsync("user-a", CancellationToken.None);
        var repeatedReceipts = await _service.ReconcilePendingDeliveriesAsync("user-a", CancellationToken.None);

        Assert.Equal(new[] { olderPending.Id, secondConversationPending.Id }, receipts.Select(item => item.Message.Id));
        Assert.Equal(new[] { "user-b", "user-c" }, receipts.Select(item => item.SenderId));
        Assert.All(receipts, receipt => Assert.NotNull(receipt.Message.DeliveredAt));
        Assert.All(receipts, receipt => Assert.Null(receipt.Message.ReadAt));
        Assert.Empty(repeatedReceipts);
        Assert.NotNull(newerDelivered.DeliveredAt);
        Assert.Equal(alreadyReadAt, alreadyRead.ReadAt);
        Assert.Null(outgoing.DeliveredAt);
    }

    [Fact]
    public async Task ReadAcknowledgementMarksOnlyIncomingMessagesThroughOrderedBoundary()
    {
        var conversation = await _service.OpenAsync("user-a", "user-b", CancellationToken.None);
        var unrelatedConversation = await _service.OpenAsync("user-a", "user-c", CancellationToken.None);
        Assert.NotNull(conversation);
        Assert.NotNull(unrelatedConversation);
        var timestamp = new DateTime(2026, 10, 11, 12, 0, 0, DateTimeKind.Utc);
        var incomingBefore = new Message
        {
            ConversationId = conversation.ConversationId,
            SenderId = "user-a",
            Content = "incoming before",
            CreatedAt = timestamp
        };
        var outgoingBoundary = new Message
        {
            ConversationId = conversation.ConversationId,
            SenderId = "user-b",
            Content = "my message",
            CreatedAt = timestamp.AddMinutes(1)
        };
        var incomingAfter = new Message
        {
            ConversationId = conversation.ConversationId,
            SenderId = "user-a",
            Content = "incoming after",
            CreatedAt = timestamp.AddMinutes(2)
        };
        var unrelatedIncoming = new Message
        {
            ConversationId = unrelatedConversation.ConversationId,
            SenderId = "user-a",
            Content = "unrelated",
            CreatedAt = timestamp
        };
        _dbContext.Messages.AddRange(incomingBefore, outgoingBoundary, incomingAfter, unrelatedIncoming);
        await _dbContext.SaveChangesAsync();
        Assert.Equal(2, await _service.GetUnreadCountAsync(
            conversation.ConversationId, "user-b", CancellationToken.None));

        var marked = await _service.MarkMessagesAsReadAsync(
            conversation.ConversationId, outgoingBoundary.Id, "user-b", CancellationToken.None);
        var markedAgain = await _service.MarkMessagesAsReadAsync(
            conversation.ConversationId, outgoingBoundary.Id, "user-b", CancellationToken.None);
        var denied = await _service.MarkMessagesAsReadAsync(
            unrelatedConversation.ConversationId, incomingBefore.Id, "user-b", CancellationToken.None);

        Assert.NotNull(marked);
        var receipt = Assert.Single(marked);
        Assert.Equal(1, await _service.GetUnreadCountAsync(
            conversation.ConversationId, "user-b", CancellationToken.None));
        Assert.Equal(incomingBefore.Id, receipt.Message.Id);
        Assert.NotNull(receipt.Message.DeliveredAt);
        Assert.NotNull(receipt.Message.ReadAt);
        Assert.Empty(markedAgain!);
        Assert.Equal(1, await _service.GetUnreadCountAsync(
            conversation.ConversationId, "user-b", CancellationToken.None));
        Assert.Null(denied);
        Assert.Null(incomingAfter.ReadAt);
        Assert.Null(outgoingBoundary.ReadAt);
        Assert.Null(unrelatedIncoming.ReadAt);
    }

    [Fact]
    public async Task MessageHistoryIncludesPersistedReceiptTimestamps()
    {
        var conversation = await _service.OpenAsync("user-a", "user-b", CancellationToken.None);
        Assert.NotNull(conversation);
        var sent = await _service.SendMessageAsync(
            conversation.ConversationId, "user-a", "hello", CancellationToken.None);
        Assert.NotNull(sent);
        await _service.MarkMessageAsDeliveredAsync(
            sent.Value.Message.Id, "user-b", CancellationToken.None);

        var page = await _service.GetMessagesAsync(
            conversation.ConversationId, "user-a", 30, null, CancellationToken.None);

        var message = Assert.Single(page!.Messages);
        Assert.NotNull(message.DeliveredAt);
        Assert.Null(message.ReadAt);
    }

    [Fact]
    public async Task MessageHistoryRejectsUnauthorizedConversationAccess()
    {
        var conversation = await _service.OpenAsync("user-a", "user-b", CancellationToken.None);
        Assert.NotNull(conversation);

        var page = await _service.GetMessagesAsync(
            conversation.ConversationId, "user-c", 30, null, CancellationToken.None);

        Assert.Null(page);
    }

    [Fact]
    public async Task MessageHistoryUsesStableCursorAcrossEqualTimestamps()
    {
        var conversation = await _service.OpenAsync("user-a", "user-b", CancellationToken.None);
        Assert.NotNull(conversation);
        var timestamp = new DateTime(2026, 10, 11, 12, 0, 0, DateTimeKind.Utc);
        _dbContext.Messages.AddRange(Enumerable.Range(1, 5).Select(index => new Message
        {
            ConversationId = conversation.ConversationId,
            SenderId = "user-a",
            Content = $"message-{index}",
            CreatedAt = timestamp
        }));
        await _dbContext.SaveChangesAsync();

        var newest = await _service.GetMessagesAsync(
            conversation.ConversationId, "user-a", 2, null, CancellationToken.None);
        var older = await _service.GetMessagesAsync(
            conversation.ConversationId, "user-a", 2, newest!.NextCursor, CancellationToken.None);
        var oldest = await _service.GetMessagesAsync(
            conversation.ConversationId, "user-a", 2, older!.NextCursor, CancellationToken.None);

        Assert.Equal(new[] { 4L, 5L }, newest!.Messages.Select(message => message.Id));
        Assert.Equal(new[] { 2L, 3L }, older!.Messages.Select(message => message.Id));
        Assert.Equal(new[] { 1L }, oldest!.Messages.Select(message => message.Id));
        Assert.True(newest.HasMore);
        Assert.True(older.HasMore);
        Assert.False(oldest.HasMore);
        Assert.Equal(5, newest.Messages.Concat(older.Messages).Concat(oldest.Messages)
            .Select(message => message.Id).Distinct().Count());
    }

    [Fact]
    public async Task SidebarOrdersByLatestMessageAndReflectsNewSends()
    {
        var bobConversation = await _service.OpenAsync("user-a", "user-b", CancellationToken.None);
        var caraConversation = await _service.OpenAsync("user-a", "user-c", CancellationToken.None);
        Assert.NotNull(bobConversation);
        Assert.NotNull(caraConversation);
        var now = DateTime.UtcNow;
        _dbContext.Messages.AddRange(
            new Message
            {
                ConversationId = bobConversation.ConversationId,
                SenderId = "user-a",
                Content = "older",
                CreatedAt = now.AddMinutes(-2)
            },
            new Message
            {
                ConversationId = caraConversation.ConversationId,
                SenderId = "user-c",
                Content = "recent",
                CreatedAt = now.AddMinutes(-1)
            });
        await _dbContext.SaveChangesAsync();

        var firstPage = await _service.GetConversationsAsync("user-a", CancellationToken.None);
        await _service.SendMessageAsync(
            bobConversation.ConversationId, "user-a", "newest", CancellationToken.None);
        var updatedPage = await _service.GetConversationsAsync("user-a", CancellationToken.None);

        Assert.Equal(caraConversation.ConversationId, firstPage[0].ConversationId);
        Assert.Equal(bobConversation.ConversationId, updatedPage[0].ConversationId);
        Assert.Equal("newest", updatedPage[0].LastMessagePreview);
        Assert.NotNull(updatedPage[0].LastMessageAt);
        Assert.Equal(2, updatedPage.Count);
    }
}