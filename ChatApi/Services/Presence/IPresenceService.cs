namespace ChatApi.Services.Presence;

public interface IPresenceService
{
    Task<bool> AddConnectionAsync(string userId, string connectionId, CancellationToken cancellationToken);
    Task<DateTime?> RemoveConnectionAsync(string userId, string connectionId, CancellationToken cancellationToken);
    PresenceSnapshot GetSnapshot(string userId, DateTime? persistedLastSeenAt);
}

public sealed record PresenceSnapshot(bool IsOnline, DateTime? LastSeenAt, DateTime? ChangedAt);