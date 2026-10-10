using ChatApi.DTOs.Auth;
using Microsoft.AspNetCore.Identity;

namespace ChatApi.Services.Auth;

public interface IAuthService
{
    Task<IdentityResult> RegisterAsync(RegisterRequest request);
    Task<AuthTokenResponse?> LoginAsync(LoginRequest request);
}