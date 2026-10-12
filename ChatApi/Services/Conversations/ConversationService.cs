using System.Globalization;
using System.Text;
using ChatApi.Data;
using ChatApi.DTOs.Conversations;
using ChatApi.Models;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;

namespace ChatApi.Services.Conversations;

public class ConversationService : IConversationService
{
    private const int MaximumPageSize = 100;
    private readonly ApplicationDbContext _dbContext;
    private readonly UserManager<ApplicationUser> _userManager;

    public ConversationService(ApplicationDbContext dbContext, UserManager<ApplicationUser> userManager)
    {
        _dbContext = dbContext;
        _userManager = userManager;
    }

    public async Task<ConversationDto?> OpenAsync(
        string currentUserId,
        string otherUserId,
        CancellationToken cancellationToken)
    {
        if (string.Equals(currentUserId, otherUserId, StringComparison.Ordinal))
        {
            return null;
        }

        if (!await _userManager.Users.AnyAsync(user => user.Id == otherUserId, cancellationToken))
        {
            return null;
        }

        var (user1Id, user2Id) = NormalizePair(currentUserId, otherUserId);
        var conversation = await FindConversationAsync(user1Id, user2Id, cancellationToken);
        if (conversation is null)
        {
            conversation = new Conversation
            {
                User1Id = user1Id,
                User2Id = user2Id,
                CreatedAt = DateTime.UtcNow
            };
            _dbContext.Conversations.Add(conversation);

            try
            {
                await _dbContext.SaveChangesAsync(cancellationToken);
            }
            catch (DbUpdateException)
            {
                _dbContext.Entry(conversation).State = EntityState.Detached;
                conversation = await FindConversationAsync(user1Id, user2Id, cancellationToken);
                if (conversation is null)
                {
                    throw;
                }
            }
        }

        var participant = await _userManager.Users
            .AsNoTracking()
            .Where(user => user.Id == otherUserId)
            .Select(user => new { user.Id, user.UserName })
            .SingleAsync(cancellationToken);

        return new ConversationDto
        {
            ConversationId = conversation.Id,
            UserId = participant.Id,
            Username = participant.UserName ?? string.Empty,
            CreatedAt = DateTime.SpecifyKind(conversation.CreatedAt, DateTimeKind.Utc)
        };
    }

    public async Task<IReadOnlyList<ConversationListItemDto>> GetConversationsAsync(
        string userId,
        CancellationToken cancellationToken)
    {
        var items = await _dbContext.Conversations
            .AsNoTracking()
            .Where(conversation => conversation.User1Id == userId || conversation.User2Id == userId)
            .Select(conversation => new
            {
                conversation.Id,
                conversation.CreatedAt,
                OtherUserId = conversation.User1Id == userId ? conversation.User2.Id : conversation.User1.Id,
                OtherUsername = conversation.User1Id == userId
                    ? conversation.User2.UserName
                    : conversation.User1.UserName,
                LastMessage = conversation.Messages
                    .OrderByDescending(message => message.CreatedAt)
                    .ThenByDescending(message => message.Id)
                    .Select(message => new { message.Content, message.CreatedAt })
                    .FirstOrDefault()
            })
            .OrderByDescending(item => item.LastMessage == null ? item.CreatedAt : item.LastMessage.CreatedAt)
            .ThenByDescending(item => item.Id)
            .ToListAsync(cancellationToken);

        return items.Select(item => new ConversationListItemDto
        {
            ConversationId = item.Id,
            OtherUserId = item.OtherUserId,
            OtherUsername = item.OtherUsername ?? string.Empty,
            LastMessagePreview = item.LastMessage?.Content,
            LastMessageAt = item.LastMessage is null
                ? null
                : DateTime.SpecifyKind(item.LastMessage.CreatedAt, DateTimeKind.Utc),
            CreatedAt = DateTime.SpecifyKind(item.CreatedAt, DateTimeKind.Utc)
        }).ToList();
    }

    public async Task<MessagePageDto?> GetMessagesAsync(
        long conversationId,
        string userId,
        int pageSize,
        string? before,
        CancellationToken cancellationToken)
    {
        if (pageSize is < 1 or > MaximumPageSize)
        {
            throw new ArgumentOutOfRangeException(nameof(pageSize));
        }

        Cursor? cursor = null;
        if (!string.IsNullOrEmpty(before) && !TryDecodeCursor(before, out cursor))
        {
            throw new FormatException("The message cursor is invalid.");
        }

        var hasAccess = await _dbContext.Conversations
            .AnyAsync(conversation => conversation.Id == conversationId &&
                (conversation.User1Id == userId || conversation.User2Id == userId), cancellationToken);
        if (!hasAccess)
        {
            return null;
        }

        if (cursor is not null && !await _dbContext.Messages.AnyAsync(message =>
                message.Id == cursor.MessageId &&
                message.ConversationId == conversationId &&
                message.CreatedAt == cursor.CreatedAt, cancellationToken))
        {
            throw new FormatException("The message cursor is invalid.");
        }

        var query = _dbContext.Messages
            .AsNoTracking()
            .Where(message => message.ConversationId == conversationId &&
                (message.Conversation.User1Id == userId || message.Conversation.User2Id == userId));

        if (cursor is not null)
        {
            query = query.Where(message => message.CreatedAt < cursor.CreatedAt ||
                (message.CreatedAt == cursor.CreatedAt && message.Id < cursor.MessageId));
        }

        var rows = await query
            .OrderByDescending(message => message.CreatedAt)
            .ThenByDescending(message => message.Id)
            .Take(pageSize + 1)
            .Select(message => new
            {
                message.Id,
                message.ConversationId,
                message.SenderId,
                message.Content,
                message.CreatedAt,
                message.DeliveredAt,
                message.ReadAt
            })
            .ToListAsync(cancellationToken);

        var hasMore = rows.Count > pageSize;
        if (hasMore)
        {
            rows.RemoveAt(rows.Count - 1);
        }

        var messages = rows.Select(message => new MessageDto
        {
            Id = message.Id,
            ConversationId = message.ConversationId,
            SenderId = message.SenderId,
            Content = message.Content,
            CreatedAt = DateTime.SpecifyKind(message.CreatedAt, DateTimeKind.Utc),
            DeliveredAt = message.DeliveredAt is null
                ? null
                : DateTime.SpecifyKind(message.DeliveredAt.Value, DateTimeKind.Utc),
            ReadAt = message.ReadAt is null
                ? null
                : DateTime.SpecifyKind(message.ReadAt.Value, DateTimeKind.Utc)
        }).ToList();
        messages.Reverse();
        return new MessagePageDto
        {
            Messages = messages,
            HasMore = hasMore,
            NextCursor = hasMore && messages.Count > 0 ? EncodeCursor(messages[0]) : null
        };
    }

    public async Task<(MessageDto Message, string RecipientId)?> SendMessageAsync(
        long conversationId,
        string senderId,
        string content,
        CancellationToken cancellationToken)
    {
        var conversation = await _dbContext.Conversations
            .AsNoTracking()
            .SingleOrDefaultAsync(item => item.Id == conversationId &&
                (item.User1Id == senderId || item.User2Id == senderId), cancellationToken);
        if (conversation is null)
        {
            return null;
        }

        var message = new Message
        {
            ConversationId = conversationId,
            SenderId = senderId,
            Content = content,
            CreatedAt = DateTime.UtcNow
        };
        _dbContext.Messages.Add(message);
        await _dbContext.SaveChangesAsync(cancellationToken);

        return (new MessageDto
        {
            Id = message.Id,
            ConversationId = message.ConversationId,
            SenderId = message.SenderId,
            Content = message.Content,
            CreatedAt = message.CreatedAt,
            DeliveredAt = message.DeliveredAt,
            ReadAt = message.ReadAt
        }, conversation.User1Id == senderId ? conversation.User2Id : conversation.User1Id);
    }

    public async Task<(MessageDto Message, string SenderId)?> MarkMessageAsDeliveredAsync(
        long messageId,
        string recipientId,
        CancellationToken cancellationToken)
    {
        var message = await _dbContext.Messages
            .Include(item => item.Conversation)
            .SingleOrDefaultAsync(item => item.Id == messageId && item.SenderId != recipientId &&
                (item.Conversation.User1Id == recipientId || item.Conversation.User2Id == recipientId),
                cancellationToken);
        if (message is null)
        {
            return null;
        }

        message.DeliveredAt ??= DateTime.UtcNow;
        await _dbContext.SaveChangesAsync(cancellationToken);
        return (ToMessageDto(message), message.SenderId);
    }

    public async Task<IReadOnlyList<(MessageDto Message, string SenderId)>> ReconcilePendingDeliveriesAsync(
        string recipientId,
        CancellationToken cancellationToken)
    {
        var pendingMessages = await _dbContext.Messages
            .Include(message => message.Conversation)
            .Where(message => message.DeliveredAt == null && message.SenderId != recipientId &&
                ((message.Conversation.User1Id == recipientId && message.Conversation.User2Id == message.SenderId) ||
                    (message.Conversation.User2Id == recipientId && message.Conversation.User1Id == message.SenderId)))
            .OrderBy(message => message.CreatedAt)
            .ThenBy(message => message.Id)
            .ToListAsync(cancellationToken);
        if (pendingMessages.Count == 0)
        {
            return [];
        }

        var deliveredAt = DateTime.UtcNow;
        foreach (var message in pendingMessages)
        {
            message.DeliveredAt ??= deliveredAt;
        }

        await _dbContext.SaveChangesAsync(cancellationToken);
        return pendingMessages
            .Select(message => (ToMessageDto(message), message.SenderId))
            .ToList();
    }

    public async Task<IReadOnlyList<(MessageDto Message, string SenderId)>?> MarkMessagesAsReadAsync(
        long conversationId,
        long lastReadMessageId,
        string readerId,
        CancellationToken cancellationToken)
    {
        var boundary = await _dbContext.Messages
            .Where(message => message.Id == lastReadMessageId && message.ConversationId == conversationId)
            .Select(message => new { message.CreatedAt })
            .SingleOrDefaultAsync(cancellationToken);
        if (boundary is null || !await _dbContext.Conversations.AnyAsync(conversation =>
                conversation.Id == conversationId &&
                (conversation.User1Id == readerId || conversation.User2Id == readerId),
                cancellationToken))
        {
            return null;
        }

        var unreadMessages = await _dbContext.Messages
            .Where(message => message.ConversationId == conversationId && message.SenderId != readerId &&
                (message.CreatedAt < boundary.CreatedAt ||
                    (message.CreatedAt == boundary.CreatedAt && message.Id <= lastReadMessageId)) &&
                message.ReadAt == null)
            .ToListAsync(cancellationToken);
        if (unreadMessages.Count == 0)
        {
            return [];
        }

        var readAt = DateTime.UtcNow;
        foreach (var message in unreadMessages)
        {
            message.DeliveredAt ??= readAt;
            message.ReadAt = readAt;
        }

        await _dbContext.SaveChangesAsync(cancellationToken);
        return unreadMessages
            .Select(message => (ToMessageDto(message), message.SenderId))
            .ToList();
    }

    private static MessageDto ToMessageDto(Message message) => new()
    {
        Id = message.Id,
        ConversationId = message.ConversationId,
        SenderId = message.SenderId,
        Content = message.Content,
        CreatedAt = DateTime.SpecifyKind(message.CreatedAt, DateTimeKind.Utc),
        DeliveredAt = message.DeliveredAt is null
            ? null
            : DateTime.SpecifyKind(message.DeliveredAt.Value, DateTimeKind.Utc),
        ReadAt = message.ReadAt is null
            ? null
            : DateTime.SpecifyKind(message.ReadAt.Value, DateTimeKind.Utc)
    };

    private Task<Conversation?> FindConversationAsync(
        string user1Id,
        string user2Id,
        CancellationToken cancellationToken) =>
        _dbContext.Conversations.AsNoTracking()
            .SingleOrDefaultAsync(item => item.User1Id == user1Id && item.User2Id == user2Id, cancellationToken);

    private static (string User1Id, string User2Id) NormalizePair(string firstUserId, string secondUserId) =>
        StringComparer.Ordinal.Compare(firstUserId, secondUserId) < 0
            ? (firstUserId, secondUserId)
            : (secondUserId, firstUserId);

    private static string EncodeCursor(MessageDto message)
    {
        var value = $"{message.CreatedAt.Ticks}:{message.Id.ToString(CultureInfo.InvariantCulture)}";
        return Convert.ToBase64String(Encoding.UTF8.GetBytes(value))
            .TrimEnd('=')
            .Replace('+', '-')
            .Replace('/', '_');
    }

    private static bool TryDecodeCursor(string value, out Cursor? cursor)
    {
        cursor = null;
        try
        {
            var base64 = value.Replace('-', '+').Replace('_', '/');
            base64 = base64.PadRight(base64.Length + (4 - base64.Length % 4) % 4, '=');
            var parts = Encoding.UTF8.GetString(Convert.FromBase64String(base64)).Split(':');
            if (parts.Length != 2 ||
                !long.TryParse(parts[0], NumberStyles.None, CultureInfo.InvariantCulture, out var ticks) ||
                ticks < DateTime.MinValue.Ticks || ticks > DateTime.MaxValue.Ticks ||
                !long.TryParse(parts[1], NumberStyles.None, CultureInfo.InvariantCulture, out var messageId) ||
                messageId < 1)
            {
                return false;
            }

            cursor = new Cursor(new DateTime(ticks, DateTimeKind.Utc), messageId);
            return true;
        }
        catch (FormatException)
        {
            return false;
        }
    }

    private sealed record Cursor(DateTime CreatedAt, long MessageId);
}