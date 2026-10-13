using ChatApi.DTOs.Conversations;

namespace ChatApi.Services.Reactions;

public enum ReactionMutationStatus
{
    Success,
    NotFound,
    Forbidden,
    InvalidEmoji
}

public sealed record ReactionMutationResult(
    ReactionMutationStatus Status,
    long MessageId = 0,
    long ConversationId = 0,
    string? RecipientId = null,
    IReadOnlyList<ReactionDto>? Reactions = null);
