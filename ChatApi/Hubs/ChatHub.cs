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
}
