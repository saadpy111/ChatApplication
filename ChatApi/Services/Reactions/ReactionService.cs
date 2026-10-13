using ChatApi.Data;
using ChatApi.DTOs.Conversations;
using ChatApi.Models;
using System.Data;
using Microsoft.EntityFrameworkCore;

namespace ChatApi.Services.Reactions;

public class ReactionService : IReactionService
{
    private static readonly IReadOnlySet<string> SupportedEmoji =
        new HashSet<string>(StringComparer.Ordinal) { "👍", "❤️", "😂", "😮", "😢", "🙏" };

    private readonly ApplicationDbContext _dbContext;

    public ReactionService(ApplicationDbContext dbContext)
    {
        _dbContext = dbContext;
    }

    public IReadOnlySet<string> AllowedEmoji => SupportedEmoji;

    public async Task<ReactionMutationResult> ReactAsync(
        long conversationId,
        long messageId,
        string userId,
        string emoji,
        CancellationToken cancellationToken)
    {
        if (!SupportedEmoji.Contains(emoji))
        {
            return new ReactionMutationResult(ReactionMutationStatus.InvalidEmoji);
        }

        await using var transaction = await _dbContext.Database.BeginTransactionAsync(
            IsolationLevel.Serializable, cancellationToken);

        // Keep message validation and the unique per-user write in one serializable operation.
        var message = await _dbContext.Messages
            .AsNoTracking()
            .Where(m => m.Id == messageId && m.ConversationId == conversationId &&
                (m.Conversation.User1Id == userId || m.Conversation.User2Id == userId))
            .Select(m => new
            {
                m.Id,
                m.ConversationId,
                m.DeletedAt,
                RecipientId = m.Conversation.User1Id == userId
                    ? m.Conversation.User2Id
                    : m.Conversation.User1Id
            })
            .SingleOrDefaultAsync(cancellationToken);

        if (message is null)
        {
            return new ReactionMutationResult(ReactionMutationStatus.NotFound);
        }

        // Reactions on deleted messages are silently rejected to avoid exposing content.
        if (message.DeletedAt is not null)
        {
            return new ReactionMutationResult(ReactionMutationStatus.Forbidden);
        }

        var existing = await _dbContext.MessageReactions
            .Where(r => r.MessageId == messageId && r.UserId == userId)
            .SingleOrDefaultAsync(cancellationToken);

        if (existing is not null)
        {
            if (string.Equals(existing.Emoji, emoji, StringComparison.Ordinal))
            {
                // Toggle off – remove the existing reaction.
                _dbContext.MessageReactions.Remove(existing);
            }
            else
            {
                // Switch to a different emoji.
                existing.Emoji = emoji;
                existing.CreatedAt = DateTime.UtcNow;
            }
        }
        else
        {
            // Add a new reaction.
            _dbContext.MessageReactions.Add(new MessageReaction
            {
                MessageId = messageId,
                UserId = userId,
                Emoji = emoji,
                CreatedAt = DateTime.UtcNow
            });
        }

        await _dbContext.SaveChangesAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);

        var reactions = await BuildReactionDtosAsync(messageId, userId, cancellationToken);
        return new ReactionMutationResult(
            ReactionMutationStatus.Success,
            MessageId: messageId,
            ConversationId: conversationId,
            RecipientId: message.RecipientId,
            Reactions: reactions);
    }

    public async Task<IReadOnlyList<ReactionDto>?> GetReactionsAsync(
        long conversationId,
        long messageId,
        string userId,
        CancellationToken cancellationToken)
    {
        var hasAccess = await _dbContext.Messages
            .AnyAsync(m => m.Id == messageId && m.ConversationId == conversationId && m.DeletedAt == null &&
                (m.Conversation.User1Id == userId || m.Conversation.User2Id == userId),
                cancellationToken);

        if (!hasAccess)
        {
            return null;
        }

        return await BuildReactionDtosAsync(messageId, userId, cancellationToken);
    }

    private async Task<IReadOnlyList<ReactionDto>> BuildReactionDtosAsync(
        long messageId,
        string currentUserId,
        CancellationToken cancellationToken)
    {
        var rows = await _dbContext.MessageReactions
            .AsNoTracking()
            .Where(r => r.MessageId == messageId && r.Message.DeletedAt == null)
            .GroupBy(r => r.Emoji)
            .Select(g => new
            {
                Emoji = g.Key,
                Count = g.Count(),
                ReactedByCurrentUser = g.Any(r => r.UserId == currentUserId)
            })
            .ToListAsync(cancellationToken);

        return rows
            .Where(r => SupportedEmoji.Contains(r.Emoji))
            .Select(r => new ReactionDto
            {
                Emoji = r.Emoji,
                Count = r.Count,
                ReactedByCurrentUser = r.ReactedByCurrentUser
            })
            .ToList();
    }
}
