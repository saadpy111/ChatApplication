using System.Security.Claims;
using ChatApi.DTOs.Users;
using ChatApi.Models;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;

namespace ChatApi.Services.Users;

public class UserSearchService : IUserSearchService
{
    private const int MaxResults = 20;
    private readonly UserManager<ApplicationUser> _userManager;

    public UserSearchService(UserManager<ApplicationUser> userManager)
    {
        _userManager = userManager;
    }

    public async Task<IReadOnlyList<UserSearchResultDto>> SearchAsync(
        string? username,
        ClaimsPrincipal currentUser,
        CancellationToken cancellationToken)
    {
        var searchTerm = username?.Trim();
        if (string.IsNullOrEmpty(searchTerm))
        {
            return Array.Empty<UserSearchResultDto>();
        }

        var currentUserId = _userManager.GetUserId(currentUser);
        var normalizedSearchTerm = _userManager.NormalizeName(searchTerm);
        if (string.IsNullOrEmpty(currentUserId) || string.IsNullOrEmpty(normalizedSearchTerm))
        {
            return Array.Empty<UserSearchResultDto>();
        }

        return await _userManager.Users
            .AsNoTracking()
            .Where(user => user.Id != currentUserId &&
                user.NormalizedUserName != null &&
                user.NormalizedUserName.Contains(normalizedSearchTerm))
            .OrderBy(user => user.NormalizedUserName)
            .ThenBy(user => user.Id)
            .Take(MaxResults)
            .Select(user => new UserSearchResultDto
            {
                UserId = user.Id,
                Username = user.UserName ?? string.Empty
            })
            .ToListAsync(cancellationToken);
    }
}