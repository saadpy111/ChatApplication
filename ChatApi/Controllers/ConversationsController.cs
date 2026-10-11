using ChatApi.DTOs.Conversations;
using ChatApi.Services.Conversations;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc;

namespace ChatApi.Controllers;

[ApiController]
[Authorize]
[Route("api/conversations")]
public class ConversationsController : ControllerBase
{
    private readonly IConversationService _conversationService;
    private readonly UserManager<Models.ApplicationUser> _userManager;

    public ConversationsController(
        IConversationService conversationService,
        UserManager<Models.ApplicationUser> userManager)
    {
        _conversationService = conversationService;
        _userManager = userManager;
    }

    [HttpPost("open/{otherUserId}")]
    [ProducesResponseType(typeof(ConversationDto), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<ConversationDto>> Open(
        string otherUserId,
        CancellationToken cancellationToken)
    {
        var currentUserId = _userManager.GetUserId(User);
        if (string.IsNullOrEmpty(currentUserId))
        {
            return Unauthorized();
        }

        if (string.Equals(currentUserId, otherUserId, StringComparison.Ordinal))
        {
            return BadRequest(new { error = "You cannot open a conversation with yourself." });
        }

        var conversation = await _conversationService.OpenAsync(currentUserId, otherUserId, cancellationToken);
        return conversation is null ? NotFound() : Ok(conversation);
    }

    [HttpGet]
    [ProducesResponseType(typeof(IReadOnlyList<ConversationListItemDto>), StatusCodes.Status200OK)]
    public async Task<ActionResult<IReadOnlyList<ConversationListItemDto>>> GetConversations(
        CancellationToken cancellationToken)
    {
        var userId = _userManager.GetUserId(User);
        if (string.IsNullOrEmpty(userId))
        {
            return Unauthorized();
        }

        return Ok(await _conversationService.GetConversationsAsync(userId, cancellationToken));
    }

    [HttpGet("{conversationId:long}/messages")]
    [ProducesResponseType(typeof(MessagePageDto), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<MessagePageDto>> GetMessages(
        long conversationId,
        [FromQuery] int pageSize = 30,
        [FromQuery] string? before = null,
        CancellationToken cancellationToken = default)
    {
        var userId = _userManager.GetUserId(User);
        if (string.IsNullOrEmpty(userId))
        {
            return Unauthorized();
        }

        try
        {
            var page = await _conversationService.GetMessagesAsync(
                conversationId, userId, pageSize, before, cancellationToken);
            return page is null ? NotFound() : Ok(page);
        }
        catch (ArgumentOutOfRangeException)
        {
            return BadRequest(new { error = "Page size must be between 1 and 100." });
        }
        catch (FormatException)
        {
            return BadRequest(new { error = "The message cursor is invalid." });
        }
    }
}