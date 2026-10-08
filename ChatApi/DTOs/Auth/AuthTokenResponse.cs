namespace ChatApi.DTOs.Auth;

public class AuthTokenResponse
{
    public string TokenType { get; init; } = "Bearer";
    public string AccessToken { get; init; } = string.Empty;
    public int ExpiresInSeconds { get; init; }
}