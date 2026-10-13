namespace ChatApi.DTOs.Conversations;

public class ReactionDto
{
    public required string Emoji { get; init; }
    public int Count { get; init; }
    public bool ReactedByCurrentUser { get; init; }
}
