namespace ChatApi.DTOs.Conversations;

public class MessageSearchPageDto
{
    public required IReadOnlyList<MessageSearchResultDto> Results { get; init; }
    public int Page { get; init; }
    public int PageSize { get; init; }
    public bool HasMore { get; init; }
}