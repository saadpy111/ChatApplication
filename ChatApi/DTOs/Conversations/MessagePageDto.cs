namespace ChatApi.DTOs.Conversations;

public class MessagePageDto
{
    public required IReadOnlyList<MessageDto> Messages { get; init; }
    public string? NextCursor { get; init; }
    public bool HasMore { get; init; }
}