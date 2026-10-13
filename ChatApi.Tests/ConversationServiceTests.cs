using ChatApi.Data;
using ChatApi.DTOs.Conversations;
using ChatApi.Hubs;
using ChatApi.Models;
using ChatApi.Services.Conversations;
using ChatApi.Services.Presence;
using ChatApi.Services.Reactions;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Identity.EntityFrameworkCore;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using Microsoft.Extensions.Logging.Abstractions;
using System.Reflection;
using System.Security.Claims;
using Xunit;

namespace ChatApi.Tests;

public sealed class ConversationServiceTests : IAsyncLifetime
{
    private readonly SqliteConnection _connection = new("Data Source=:memory:");
    private readonly IPresenceService _presenceService = new TestPresenceService();
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
        _service = new ConversationService(_dbContext, userManager, _presenceService);
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
    public async Task EditMessageTrimsContentAndEnforcesOwnershipAndValidation()
    {
        var conversation = await _service.OpenAsync("user-a", "user-b", CancellationToken.None);
        Assert.NotNull(conversation);
        var sent = await _service.SendMessageAsync(
            conversation.ConversationId, "user-a", "original", CancellationToken.None);
        Assert.NotNull(sent);

        var edited = await _service.EditMessageAsync(
            conversation.ConversationId, sent.Value.Message.Id, "user-a", "  revised  ", CancellationToken.None);
        var unchanged = await _service.EditMessageAsync(
            conversation.ConversationId, sent.Value.Message.Id, "user-a", "revised", CancellationToken.None);
        var otherSender = await _service.EditMessageAsync(
            conversation.ConversationId, sent.Value.Message.Id, "user-b", "intrusion", CancellationToken.None);
        var outsider = await _service.EditMessageAsync(
            conversation.ConversationId, sent.Value.Message.Id, "user-c", "intrusion", CancellationToken.None);

        Assert.Equal(MessageMutationStatus.Updated, edited.Status);
        Assert.Equal("revised", edited.Message!.Content);
        Assert.NotNull(edited.Message.EditedAt);
        Assert.Equal("user-b", edited.RecipientId);
        Assert.True(edited.Changed);
        var updatedSearch = await _service.SearchMessagesAsync(
            "user-a", "revised", 1, 20, CancellationToken.None);
        var oldSearch = await _service.SearchMessagesAsync(
            "user-a", "original", 1, 20, CancellationToken.None);
        Assert.Equal("revised", Assert.Single(updatedSearch.Results).Content);
        Assert.Empty(oldSearch.Results);
        Assert.Equal(MessageMutationStatus.Unchanged, unchanged.Status);
        Assert.Equal(MessageMutationStatus.Forbidden, otherSender.Status);
        Assert.Equal(MessageMutationStatus.NotFound, outsider.Status);
        await Assert.ThrowsAsync<ArgumentException>(() => _service.EditMessageAsync(
            conversation.ConversationId, sent.Value.Message.Id, "user-a", "  ", CancellationToken.None));
        await Assert.ThrowsAsync<ArgumentException>(() => _service.EditMessageAsync(
            conversation.ConversationId, sent.Value.Message.Id, "user-a",
            new string('x', Message.MaxContentLength + 1), CancellationToken.None));
    }

    [Fact]
    public async Task DeleteMessageRedactsContentPreservesReceiptsAndExcludesSearch()
    {
        var conversation = await _service.OpenAsync("user-a", "user-b", CancellationToken.None);
        Assert.NotNull(conversation);
        var sent = await _service.SendMessageAsync(
            conversation.ConversationId, "user-a", "private phrase", CancellationToken.None);
        Assert.NotNull(sent);
        await _service.MarkMessageAsDeliveredAsync(
            sent.Value.Message.Id, "user-b", CancellationToken.None);
        await _service.MarkMessagesAsReadAsync(
            conversation.ConversationId, sent.Value.Message.Id, "user-b", CancellationToken.None);

        var forbidden = await _service.DeleteMessageAsync(
            conversation.ConversationId, sent.Value.Message.Id, "user-b", CancellationToken.None);
        var outsider = await _service.DeleteMessageAsync(
            conversation.ConversationId, sent.Value.Message.Id, "user-c", CancellationToken.None);
        var deleted = await _service.DeleteMessageAsync(
            conversation.ConversationId, sent.Value.Message.Id, "user-a", CancellationToken.None);
        var repeated = await _service.DeleteMessageAsync(
            conversation.ConversationId, sent.Value.Message.Id, "user-a", CancellationToken.None);

        Assert.Equal(MessageMutationStatus.Forbidden, forbidden.Status);
        Assert.Equal(MessageMutationStatus.NotFound, outsider.Status);
        Assert.Equal(MessageMutationStatus.Updated, deleted.Status);
        Assert.True(deleted.Changed);
        Assert.Equal(string.Empty, deleted.Message!.Content);
        Assert.True(deleted.Message.IsDeleted);
        Assert.NotNull(deleted.Message.DeletedAt);
        Assert.False(repeated.Changed);
        Assert.True(repeated.Message!.IsDeleted);

        var stored = await _dbContext.Messages.SingleAsync();
        Assert.Equal(string.Empty, stored.Content);
        Assert.NotNull(stored.DeliveredAt);
        Assert.NotNull(stored.ReadAt);

        var history = await _service.GetMessagesAsync(
            conversation.ConversationId, "user-a", 30, null, CancellationToken.None);
        Assert.True(Assert.Single(history!.Messages).IsDeleted);
        Assert.Equal(string.Empty, history.Messages[0].Content);

        var context = await _service.GetMessageContextAsync(
            conversation.ConversationId, sent.Value.Message.Id, "user-b", CancellationToken.None);
        Assert.True(Assert.Single(context!.Messages).IsDeleted);
        var search = await _service.SearchMessagesAsync(
            "user-a", "private phrase", 1, 20, CancellationToken.None);
        Assert.Empty(search.Results);

        var sidebar = Assert.Single(await _service.GetConversationsAsync("user-a", CancellationToken.None));
        Assert.Equal("Message deleted", sidebar.LastMessagePreview);
    }

    [Fact]
    public async Task GetTypingTargetRequiresMembershipAndUsesSenderUsername()
    {
        var conversation = await _service.OpenAsync("user-a", "user-b", CancellationToken.None);
        Assert.NotNull(conversation);

        var recipient = await _service.GetTypingTargetAsync(
            conversation.ConversationId, "user-a", CancellationToken.None);
        var reverseRecipient = await _service.GetTypingTargetAsync(
            conversation.ConversationId, "user-b", CancellationToken.None);
        var unauthorized = await _service.GetTypingTargetAsync(
            conversation.ConversationId, "user-c", CancellationToken.None);

        Assert.Equal(("user-b", "alice"), recipient);
        Assert.Equal(("user-a", "bob"), reverseRecipient);
        Assert.Null(unauthorized);
        Assert.Empty(await _dbContext.Messages.ToListAsync());
    }

    [Fact]
    public async Task HubTypingEventsUseAuthenticatedSenderAndTargetOnlyConversationPartner()
    {
        var conversation = await _service.OpenAsync("user-a", "user-b", CancellationToken.None);
        Assert.NotNull(conversation);
        var transport = new RecordingHubTransport();
        var hub = new ChatHub(_service, _presenceService, new NullReactionService())
        {
            Context = new TestHubCallerContext("user-a"),
            Clients = transport.Clients
        };

        await hub.TypingStarted(conversation.ConversationId);

        Assert.Equal("user-b", transport.RecipientId);
        Assert.Equal("UserTyping", transport.EventName);
        Assert.Equal(conversation.ConversationId, GetPayloadValue<long>(transport.Payload!, "ConversationId"));
        Assert.Equal("user-a", GetPayloadValue<string>(transport.Payload!, "UserId"));
        Assert.Equal("alice", GetPayloadValue<string>(transport.Payload!, "DisplayName"));

        await hub.TypingStopped(conversation.ConversationId);

        Assert.Equal("user-b", transport.RecipientId);
        Assert.Equal("UserStoppedTyping", transport.EventName);
        Assert.Equal("user-a", GetPayloadValue<string>(transport.Payload!, "UserId"));
        Assert.Empty(await _dbContext.Messages.ToListAsync());

        var unauthorizedTransport = new RecordingHubTransport();
        var unauthorizedHub = new ChatHub(_service, _presenceService, new NullReactionService())
        {
            Context = new TestHubCallerContext("user-c"),
            Clients = unauthorizedTransport.Clients
        };
        await Assert.ThrowsAsync<HubException>(() => unauthorizedHub.TypingStarted(conversation.ConversationId));
        Assert.Null(unauthorizedTransport.RecipientId);
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
    public async Task SearchMessagesScopesResultsToParticipantsOrdersAndPaginates()
    {
        var firstConversation = await _service.OpenAsync("user-a", "user-b", CancellationToken.None);
        var secondConversation = await _service.OpenAsync("user-a", "user-c", CancellationToken.None);
        var privateConversation = await _service.OpenAsync("user-b", "user-c", CancellationToken.None);
        Assert.NotNull(firstConversation);
        Assert.NotNull(secondConversation);
        Assert.NotNull(privateConversation);
        var createdAt = new DateTime(2026, 10, 11, 12, 0, 0, DateTimeKind.Utc);

        _dbContext.Messages.AddRange(
            new Message
            {
                ConversationId = firstConversation.ConversationId,
                SenderId = "user-b",
                Content = "Found Needle 100% complete",
                CreatedAt = createdAt
            },
            new Message
            {
                ConversationId = secondConversation.ConversationId,
                SenderId = "user-c",
                Content = "Another needle 100% complete",
                CreatedAt = createdAt
            },
            new Message
            {
                ConversationId = privateConversation.ConversationId,
                SenderId = "user-b",
                Content = "Needle must stay private",
                CreatedAt = createdAt.AddMinutes(1)
            });
        await _dbContext.SaveChangesAsync();

        var firstPage = await _service.SearchMessagesAsync(
            "user-a", "  NEEDLE  ", 1, 1, CancellationToken.None);
        var secondPage = await _service.SearchMessagesAsync(
            "user-a", "needle", 2, 1, CancellationToken.None);
        var literalWildcard = await _service.SearchMessagesAsync(
            "user-a", "%", 1, 20, CancellationToken.None);

        var newest = Assert.Single(firstPage.Results);
        Assert.Equal(secondConversation.ConversationId, newest.ConversationId);
        Assert.Equal("cara", newest.SenderDisplayName);
        Assert.Equal("cara", newest.OtherUsername);
        Assert.True(firstPage.HasMore);
        Assert.Equal(1, firstPage.Page);
        Assert.Equal(1, firstPage.PageSize);

        var older = Assert.Single(secondPage.Results);
        Assert.Equal(firstConversation.ConversationId, older.ConversationId);
        Assert.Equal("bob", older.SenderDisplayName);
        Assert.Equal("bob", older.OtherUsername);
        Assert.False(secondPage.HasMore);
        Assert.Equal(2, literalWildcard.Results.Count);
        Assert.DoesNotContain(firstPage.Results, result => result.ConversationId == privateConversation.ConversationId);
    }

    [Fact]
    public async Task SearchMessagesRejectsInvalidTermsAndPaginationAndReturnsNoMatches()
    {
        await Assert.ThrowsAsync<ArgumentException>(() => _service.SearchMessagesAsync(
            "user-a", "   ", 1, 20, CancellationToken.None));
        await Assert.ThrowsAsync<ArgumentException>(() => _service.SearchMessagesAsync(
            "user-a", new string('x', 201), 1, 20, CancellationToken.None));
        await Assert.ThrowsAsync<ArgumentOutOfRangeException>(() => _service.SearchMessagesAsync(
            "user-a", "term", 0, 20, CancellationToken.None));
        await Assert.ThrowsAsync<ArgumentOutOfRangeException>(() => _service.SearchMessagesAsync(
            "user-a", "term", 1, 51, CancellationToken.None));

        var noMatches = await _service.SearchMessagesAsync(
            "user-a", "missing", 1, 20, CancellationToken.None);

        Assert.Empty(noMatches.Results);
        Assert.False(noMatches.HasMore);
    }

    [Fact]
    public async Task GetMessageContextIncludesTargetAndRequiresConversationMembership()
    {
        var conversation = await _service.OpenAsync("user-a", "user-b", CancellationToken.None);
        Assert.NotNull(conversation);
        var createdAt = new DateTime(2026, 10, 11, 12, 0, 0, DateTimeKind.Utc);
        var history = Enumerable.Range(1, 35).Select(index => new Message
        {
            ConversationId = conversation.ConversationId,
            SenderId = index % 2 == 0 ? "user-a" : "user-b",
            Content = $"message {index}",
            CreatedAt = createdAt.AddMinutes(index)
        }).ToArray();
        _dbContext.Messages.AddRange(history);
        await _dbContext.SaveChangesAsync();

        var context = await _service.GetMessageContextAsync(
            conversation.ConversationId, history[17].Id, "user-a", CancellationToken.None);
        var unauthorized = await _service.GetMessageContextAsync(
            conversation.ConversationId, history[17].Id, "user-c", CancellationToken.None);

        Assert.NotNull(context);
        Assert.Equal(30, context.Messages.Count);
        Assert.Equal(history[17].Id, context.Messages[15].Id);
        Assert.Equal(history[18].Id, context.Messages[16].Id);
        Assert.True(context.HasMore);
        Assert.NotNull(context.NextCursor);
        Assert.Null(unauthorized);
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

    private static T GetPayloadValue<T>(object payload, string propertyName)
    {
        return (T)payload.GetType().GetProperty(propertyName)!.GetValue(payload)!;
    }

    private sealed class TestPresenceService : IPresenceService
    {
        public Task<bool> AddConnectionAsync(string userId, string connectionId, CancellationToken cancellationToken) =>
            Task.FromResult(false);

        public Task<DateTime?> RemoveConnectionAsync(string userId, string connectionId, CancellationToken cancellationToken) =>
            Task.FromResult<DateTime?>(null);

        public PresenceSnapshot GetSnapshot(string userId, DateTime? persistedLastSeenAt) =>
            new(false, persistedLastSeenAt, persistedLastSeenAt);
    }

    private sealed class TestHubCallerContext(string userId) : HubCallerContext
    {
        private readonly IDictionary<object, object?> _items = new Dictionary<object, object?>();

        public override string ConnectionId => "test-connection";
        public override string? UserIdentifier => userId;
        public override ClaimsPrincipal? User => new(new ClaimsIdentity([new Claim(ClaimTypes.NameIdentifier, userId)]));
        public override IDictionary<object, object?> Items => _items;
        public override IFeatureCollection Features { get; } = new FeatureCollection();
        public override CancellationToken ConnectionAborted => CancellationToken.None;
        public override void Abort() { }
    }

    private sealed class RecordingHubTransport
    {
        private readonly IClientProxy _client;
        private readonly IHubCallerClients _clients;

        public RecordingHubTransport()
        {
            _client = DispatchProxy.Create<IClientProxy, RecordingClientProxy>();
            ((RecordingClientProxy)(object)_client).Sent = (eventName, payload) =>
            {
                EventName = eventName;
                Payload = payload;
            };
            _clients = DispatchProxy.Create<IHubCallerClients, RecordingClientsProxy>();
            ((RecordingClientsProxy)(object)_clients).Initialize(_client, recipientId => RecipientId = recipientId);
        }

        public IHubCallerClients Clients => _clients;
        public string? RecipientId { get; private set; }
        public string? EventName { get; private set; }
        public object? Payload { get; private set; }
    }

    public class RecordingClientsProxy : DispatchProxy
    {
        private IClientProxy _client = null!;
        private Action<string>? _recipientSelected;

        public void Initialize(IClientProxy client, Action<string> recipientSelected)
        {
            _client = client;
            _recipientSelected = recipientSelected;
        }

        protected override object? Invoke(MethodInfo? targetMethod, object?[]? args)
        {
            if (targetMethod?.Name == "User")
            {
                _recipientSelected?.Invoke((string)args![0]!);
                return _client;
            }

            throw new NotSupportedException($"Unexpected SignalR client method: {targetMethod?.Name}");
        }
    }

    public class RecordingClientProxy : DispatchProxy
    {
        public Action<string, object?>? Sent { get; set; }

        protected override object? Invoke(MethodInfo? targetMethod, object?[]? args)
        {
            if (targetMethod?.Name == nameof(IClientProxy.SendCoreAsync))
            {
                Sent?.Invoke((string)args![0]!, ((object?[])args[1]!)[0]);
                return Task.CompletedTask;
            }

            throw new NotSupportedException($"Unexpected SignalR proxy method: {targetMethod?.Name}");
        }
    }

    // Minimal stub used to satisfy the ChatHub constructor in tests that don't exercise reactions.
    private sealed class NullReactionService : IReactionService
    {
        public IReadOnlySet<string> AllowedEmoji => new HashSet<string>();

        public Task<ReactionMutationResult> ReactAsync(
            long conversationId,
            long messageId,
            string userId,
            string emoji,
            CancellationToken cancellationToken) =>
            Task.FromResult(new ReactionMutationResult(ReactionMutationStatus.NotFound));

        public Task<IReadOnlyList<ReactionDto>?> GetReactionsAsync(
            long conversationId,
            long messageId,
            string userId,
            CancellationToken cancellationToken) =>
            Task.FromResult<IReadOnlyList<ReactionDto>?>(null);
    }
}