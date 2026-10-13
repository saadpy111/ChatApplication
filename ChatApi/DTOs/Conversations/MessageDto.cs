namespace ChatApi.DTOs.Conversations;

public class MessageDto
{
    public long Id { get; init; }
    public long ConversationId { get; init; }
    public required string SenderId { get; init; }
    public required string Content { get; init; }
    public DateTime CreatedAt { get; init; }
    public DateTime? EditedAt { get; init; }
    public DateTime? DeletedAt { get; init; }
    public bool IsDeleted { get; init; }
    public DateTime? DeliveredAt { get; init; }
    public DateTime? ReadAt { get; init; }
}