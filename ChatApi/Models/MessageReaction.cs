namespace ChatApi.Models;

public class MessageReaction
{
    public long Id { get; set; }
    public long MessageId { get; set; }
    public required string UserId { get; set; }
    public required string Emoji { get; set; }
    public DateTime CreatedAt { get; set; }
    public Message Message { get; set; } = null!;
    public ApplicationUser User { get; set; } = null!;
}
