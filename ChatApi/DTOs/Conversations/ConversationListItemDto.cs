namespace ChatApi.DTOs.Conversations;

public class ConversationListItemDto
{
    public long ConversationId { get; init; }
    public required string OtherUserId { get; init; }
    public required string OtherUsername { get; init; }
    public string? LastMessagePreview { get; init; }
    public DateTime? LastMessageAt { get; init; }
    public DateTime CreatedAt { get; init; }
    public int UnreadCount { get; init; }
    public bool OtherUserIsOnline { get; init; }
    public DateTime? OtherUserLastSeenAt { get; init; }
    public DateTime? OtherUserPresenceChangedAt { get; init; }
}