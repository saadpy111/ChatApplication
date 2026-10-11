namespace ChatApi.DTOs.Conversations;

public class MessageDto
{
    public long Id { get; init; }
    public long ConversationId { get; init; }
    public required string SenderId { get; init; }
    public required string Content { get; init; }
    public DateTime CreatedAt { get; init; }
}