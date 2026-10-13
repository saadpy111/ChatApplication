using Microsoft.AspNetCore.Identity;

namespace ChatApi.Models;

public class ApplicationUser : IdentityUser
{
	public DateTime? LastSeenAt { get; set; }
}