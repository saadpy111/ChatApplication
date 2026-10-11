namespace ChatApi.DTOs.Conversations;

public class ConversationDto
{
    public long ConversationId { get; init; }
    public required string UserId { get; init; }
    public required string Username { get; init; }
    public DateTime CreatedAt { get; init; }
}