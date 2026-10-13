using ChatApi.DTOs.Conversations;
using ChatApi.Models;
using ChatApi.Services.Conversations;
using ChatApi.Services.Presence;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;

namespace ChatApi.Hubs;
[Authorize]
public class ChatHub : Hub
{
    private readonly IConversationService _conversationService;
    private readonly IPresenceService _presenceService;

    public ChatHub(IConversationService conversationService, IPresenceService presenceService)
    {
        _conversationService = conversationService;
        _presenceService = presenceService;
    }

    public override async Task OnConnectedAsync()
    {
        var userId = Context.UserIdentifier;
        if (!string.IsNullOrEmpty(userId) && await _presenceService.AddConnectionAsync(
                userId, Context.ConnectionId, Context.ConnectionAborted))
        {
            var observers = await _conversationService.GetPresenceObserverIdsAsync(
                userId, Context.ConnectionAborted);
            if (observers.Count > 0)
            {
                await Clients.Users(observers).SendAsync("UserOnline", new
                {
                    UserId = userId,
                    IsOnline = true,
                    LastSeenAt = (DateTime?)null,
                    ChangedAt = DateTime.UtcNow
                }, Context.ConnectionAborted);
            }
        }

        await base.OnConnectedAsync();
    }

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        try
        {
            var userId = Context.UserIdentifier;
            if (!string.IsNullOrEmpty(userId))
            {
                var lastSeenAt = await _presenceService.RemoveConnectionAsync(
                    userId, Context.ConnectionId, CancellationToken.None);
                if (lastSeenAt is not null)
                {
                    var observers = await _conversationService.GetPresenceObserverIdsAsync(
                        userId, CancellationToken.None);
                    if (observers.Count > 0)
                    {
                        await Clients.Users(observers).SendAsync("UserOffline", new
                        {
                            UserId = userId,
                            IsOnline = false,
                            LastSeenAt = lastSeenAt,
                            ChangedAt = lastSeenAt
                        });
                    }
                }
            }
        }
        finally
        {
            await base.OnDisconnectedAsync(exception);
        }
    }

    public async Task<MessageDto> SendMessage(long conversationId, string content)
    {
        var senderId = Context.UserIdentifier;
        if (string.IsNullOrEmpty(senderId))
        {
            throw new HubException("The sender could not be identified.");
        }

        content = content?.Trim() ?? string.Empty;
        if (content.Length is < 1 or > Message.MaxContentLength)
        {
            throw new HubException($"Message content must contain between 1 and {Message.MaxContentLength} characters.");
        }

        var saved = await _conversationService.SendMessageAsync(
            conversationId, senderId, content, Context.ConnectionAborted);
        if (saved is null)
        {
            throw new HubException("The conversation is unavailable.");
        }

        await Clients.Users(senderId, saved.Value.RecipientId)
            .SendAsync("ReceiveMessage", saved.Value.Message, Context.ConnectionAborted);
        await SendUnreadCountUpdatedAsync(saved.Value.Message.ConversationId, saved.Value.RecipientId);
        return saved.Value.Message;
    }

    public Task TypingStarted(long conversationId) => SendTypingEventAsync(conversationId, true);

    public Task TypingStopped(long conversationId) => SendTypingEventAsync(conversationId, false);

    public async Task AcknowledgeDelivered(long messageId)
    {
        var recipientId = Context.UserIdentifier;
        if (string.IsNullOrEmpty(recipientId))
        {
            throw new HubException("The recipient could not be identified.");
        }

        var receipt = await _conversationService.MarkMessageAsDeliveredAsync(
            messageId, recipientId, Context.ConnectionAborted);
        if (receipt is null)
        {
            throw new HubException("The message is unavailable.");
        }

        await Clients.User(receipt.Value.SenderId)
            .SendAsync("MessageStatusUpdated", receipt.Value.Message, Context.ConnectionAborted);
    }

    public async Task ReconcilePendingDeliveries()
    {
        var recipientId = Context.UserIdentifier;
        if (string.IsNullOrEmpty(recipientId))
        {
            throw new HubException("The recipient could not be identified.");
        }

        var receipts = await _conversationService.ReconcilePendingDeliveriesAsync(
            recipientId, Context.ConnectionAborted);
        foreach (var receipt in receipts)
        {
            await Clients.User(receipt.SenderId)
                .SendAsync("MessageStatusUpdated", receipt.Message, Context.ConnectionAborted);
        }
    }

    public async Task AcknowledgeRead(long conversationId, long lastReadMessageId)
    {
        var readerId = Context.UserIdentifier;
        if (string.IsNullOrEmpty(readerId))
        {
            throw new HubException("The reader could not be identified.");
        }

        var receipts = await _conversationService.MarkMessagesAsReadAsync(
            conversationId, lastReadMessageId, readerId, Context.ConnectionAborted);
        if (receipts is null)
        {
            throw new HubException("The conversation or message is unavailable.");
        }

        foreach (var receipt in receipts)
        {
            await Clients.User(receipt.SenderId)
                .SendAsync("MessageStatusUpdated", receipt.Message, Context.ConnectionAborted);
        }

        await SendUnreadCountUpdatedAsync(conversationId, readerId);
    }

    private async Task SendUnreadCountUpdatedAsync(long conversationId, string userId)
    {
        var unreadCount = await _conversationService.GetUnreadCountAsync(
            conversationId, userId, Context.ConnectionAborted);
        await Clients.User(userId).SendAsync("UnreadCountUpdated", new
        {
            ConversationId = conversationId,
            UnreadCount = unreadCount
        }, Context.ConnectionAborted);
    }

    private async Task SendTypingEventAsync(long conversationId, bool isTyping)
    {
        var userId = Context.UserIdentifier;
        if (string.IsNullOrEmpty(userId))
        {
            throw new HubException("The user could not be identified.");
        }

        var typingTarget = await _conversationService.GetTypingTargetAsync(
            conversationId, userId, Context.ConnectionAborted);
        if (typingTarget is null)
        {
            throw new HubException("The conversation is unavailable.");
        }

        if (isTyping)
        {
            await Clients.User(typingTarget.Value.RecipientId).SendAsync("UserTyping", new
            {
                ConversationId = conversationId,
                UserId = userId,
                DisplayName = typingTarget.Value.SenderDisplayName
            }, Context.ConnectionAborted);
            return;
        }

        await Clients.User(typingTarget.Value.RecipientId).SendAsync("UserStoppedTyping", new
        {
            ConversationId = conversationId,
            UserId = userId
        }, Context.ConnectionAborted);
    }
}
