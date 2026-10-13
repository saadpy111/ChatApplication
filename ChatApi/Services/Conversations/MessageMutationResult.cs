using ChatApi.DTOs.Conversations;

namespace ChatApi.Services.Conversations;

public enum MessageMutationStatus
{
    Updated,
    NotFound,
    Forbidden,
    AlreadyDeleted,
    Unchanged
}

public sealed record MessageMutationResult(
    MessageMutationStatus Status,
    MessageDto? Message = null,
    string? RecipientId = null,
    bool Changed = false);