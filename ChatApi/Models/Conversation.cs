namespace ChatApi.Models;

public class Conversation
{
    public long Id { get; set; }
    public required string User1Id { get; set; }
    public required string User2Id { get; set; }
    public DateTime CreatedAt { get; set; }
    public ApplicationUser User1 { get; set; } = null!;
    public ApplicationUser User2 { get; set; } = null!;
    public ICollection<Message> Messages { get; set; } = new List<Message>();
}