using System.Security.Claims;
using ChatApi.DTOs.Users;

namespace ChatApi.Services.Users;

public interface IUserSearchService
{
    Task<IReadOnlyList<UserSearchResultDto>> SearchAsync(
        string? username,
        ClaimsPrincipal currentUser,
        CancellationToken cancellationToken);
}