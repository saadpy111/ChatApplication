namespace ChatApi.Models;

public class Message
{
    public const int MaxContentLength = 2000;

    public long Id { get; set; }
    public long ConversationId { get; set; }
    public required string SenderId { get; set; }
    public required string Content { get; set; }
    public DateTime CreatedAt { get; set; }
    public Conversation Conversation { get; set; } = null!;
    public ApplicationUser Sender { get; set; } = null!;
}