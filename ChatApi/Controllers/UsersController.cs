using ChatApi.DTOs.Users;
using ChatApi.Services.Users;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace ChatApi.Controllers;

[ApiController]
[Authorize]
[Route("api/users")]
public class UsersController : ControllerBase
{
    private readonly IUserSearchService _userSearchService;

    public UsersController(IUserSearchService userSearchService)
    {
        _userSearchService = userSearchService;
    }

    [HttpGet("search")]
    [ProducesResponseType(typeof(IReadOnlyList<UserSearchResultDto>), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status401Unauthorized)]
    public async Task<ActionResult<IReadOnlyList<UserSearchResultDto>>> Search(
        [FromQuery] string? username,
        CancellationToken cancellationToken)
    {
        var users = await _userSearchService.SearchAsync(username, User, cancellationToken);
        return Ok(users);
    }
}