using ChatApi.DTOs.Conversations;

namespace ChatApi.Services.Reactions;

public interface IReactionService
{
    /// <summary>
    /// Returns the set of allowed emoji values.
    /// </summary>
    IReadOnlySet<string> AllowedEmoji { get; }

    /// <summary>
    /// Adds, changes, or removes the calling user's reaction on a message.
    /// Toggling the same emoji that is already active removes it.
    /// </summary>
    Task<ReactionMutationResult> ReactAsync(
        long conversationId,
        long messageId,
        string userId,
        string emoji,
        CancellationToken cancellationToken);

    /// <summary>
    /// Loads the aggregated reaction counts for a message, from the perspective
    /// of the requesting user. Returns null when the message or conversation is
    /// not found or the user does not have access.
    /// </summary>
    Task<IReadOnlyList<ReactionDto>?> GetReactionsAsync(
        long conversationId,
        long messageId,
        string userId,
        CancellationToken cancellationToken);
}
