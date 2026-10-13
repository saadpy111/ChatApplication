using System.Collections.Concurrent;
using ChatApi.Data;
using Microsoft.EntityFrameworkCore;

namespace ChatApi.Services.Presence;

public sealed class PresenceService : IPresenceService
{
    private readonly ConcurrentDictionary<string, UserConnections> _users = new(StringComparer.Ordinal);
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly ILogger<PresenceService> _logger;

    public PresenceService(IServiceScopeFactory scopeFactory, ILogger<PresenceService> logger)
    {
        _scopeFactory = scopeFactory;
        _logger = logger;
    }

    public async Task<bool> AddConnectionAsync(
        string userId,
        string connectionId,
        CancellationToken cancellationToken)
    {
        var user = _users.GetOrAdd(userId, static _ => new UserConnections());
        await user.Gate.WaitAsync(cancellationToken);
        try
        {
            lock (user.SyncRoot)
            {
                var wasOffline = user.ConnectionIds.Count == 0;
                if (!user.ConnectionIds.Add(connectionId))
                {
                    return false;
                }

                if (wasOffline)
                {
                    user.ChangedAt = DateTime.UtcNow;
                }

                return wasOffline;
            }
        }
        finally
        {
            user.Gate.Release();
        }
    }

    public async Task<DateTime?> RemoveConnectionAsync(
        string userId,
        string connectionId,
        CancellationToken cancellationToken)
    {
        if (!_users.TryGetValue(userId, out var user))
        {
            return null;
        }

        await user.Gate.WaitAsync(cancellationToken);
        try
        {
            DateTime lastSeenAt;
            lock (user.SyncRoot)
            {
                if (!user.ConnectionIds.Remove(connectionId) || user.ConnectionIds.Count > 0)
                {
                    return null;
                }

                lastSeenAt = DateTime.UtcNow;
                if (user.LastSeenAt is { } previousLastSeenAt && previousLastSeenAt >= lastSeenAt)
                {
                    lastSeenAt = previousLastSeenAt.AddTicks(1);
                }

                user.LastSeenAt = lastSeenAt;
                user.ChangedAt = lastSeenAt;
            }

            try
            {
                await PersistLastSeenAsync(userId, lastSeenAt, cancellationToken);
            }
            catch (Exception exception)
            {
                _logger.LogError(exception, "Failed to persist last-seen time for user {UserId}.", userId);
            }

            return lastSeenAt;
        }
        finally
        {
            user.Gate.Release();
        }
    }

    public PresenceSnapshot GetSnapshot(string userId, DateTime? persistedLastSeenAt)
    {
        if (!_users.TryGetValue(userId, out var user))
        {
            return new PresenceSnapshot(false, persistedLastSeenAt, persistedLastSeenAt);
        }

        lock (user.SyncRoot)
        {
            var isOnline = user.ConnectionIds.Count > 0;
            var lastSeenAt = user.LastSeenAt ?? persistedLastSeenAt;
            return new PresenceSnapshot(isOnline, lastSeenAt, user.ChangedAt ?? lastSeenAt);
        }
    }

    private async Task PersistLastSeenAsync(
        string userId,
        DateTime lastSeenAt,
        CancellationToken cancellationToken)
    {
        await using var scope = _scopeFactory.CreateAsyncScope();
        var dbContext = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await dbContext.Users
            .Where(user => user.Id == userId && (user.LastSeenAt == null || user.LastSeenAt < lastSeenAt))
            .ExecuteUpdateAsync(
                updates => updates.SetProperty(user => user.LastSeenAt, lastSeenAt),
                cancellationToken);
    }

    private sealed class UserConnections
    {
        public object SyncRoot { get; } = new();
        public SemaphoreSlim Gate { get; } = new(1, 1);
        public HashSet<string> ConnectionIds { get; } = new(StringComparer.Ordinal);
        public DateTime? LastSeenAt { get; set; }
        public DateTime? ChangedAt { get; set; }
    }
}