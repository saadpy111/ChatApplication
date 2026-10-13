using ChatApi.DTOs.Conversations;

namespace ChatApi.Services.Conversations;

public interface IConversationService
{
    Task<ConversationDto?> OpenAsync(string currentUserId, string otherUserId, CancellationToken cancellationToken);
    Task<IReadOnlyList<ConversationListItemDto>> GetConversationsAsync(string userId, CancellationToken cancellationToken);
    Task<int> GetUnreadCountAsync(long conversationId, string userId, CancellationToken cancellationToken);
    Task<(string RecipientId, string SenderDisplayName)?> GetTypingTargetAsync(
        long conversationId,
        string userId,
        CancellationToken cancellationToken);
    Task<MessagePageDto?> GetMessagesAsync(
        long conversationId,
        string userId,
        int pageSize,
        string? before,
        CancellationToken cancellationToken);
    Task<MessagePageDto?> GetMessageContextAsync(
        long conversationId,
        long messageId,
        string userId,
        CancellationToken cancellationToken);
    Task<MessageSearchPageDto> SearchMessagesAsync(
        string userId,
        string? query,
        int page,
        int pageSize,
        CancellationToken cancellationToken);
    Task<(MessageDto Message, string RecipientId)?> SendMessageAsync(
        long conversationId,
        string senderId,
        string content,
        CancellationToken cancellationToken);
    Task<(MessageDto Message, string SenderId)?> MarkMessageAsDeliveredAsync(
        long messageId,
        string recipientId,
        CancellationToken cancellationToken);
    Task<IReadOnlyList<(MessageDto Message, string SenderId)>> ReconcilePendingDeliveriesAsync(
        string recipientId,
        CancellationToken cancellationToken);
    Task<IReadOnlyList<(MessageDto Message, string SenderId)>?> MarkMessagesAsReadAsync(
        long conversationId,
        long lastReadMessageId,
        string readerId,
        CancellationToken cancellationToken);
}