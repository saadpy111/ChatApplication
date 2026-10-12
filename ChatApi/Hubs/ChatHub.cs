using ChatApi.DTOs.Conversations;
using ChatApi.Models;
using ChatApi.Services.Conversations;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;

namespace ChatApi.Hubs;
[Authorize]
public class ChatHub : Hub
{
    private readonly IConversationService _conversationService;

    public ChatHub(IConversationService conversationService)
    {
        _conversationService = conversationService;
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
        return saved.Value.Message;
    }

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
    }
}
