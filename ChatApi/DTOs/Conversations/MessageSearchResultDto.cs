namespace ChatApi.DTOs.Conversations;

public class MessageSearchResultDto
{
    public long MessageId { get; init; }
    public long ConversationId { get; init; }
    public required string Content { get; init; }
    public required string SenderId { get; init; }
    public required string SenderDisplayName { get; init; }
    public required string OtherUserId { get; init; }
    public required string OtherUsername { get; init; }
    public DateTime CreatedAt { get; init; }
}