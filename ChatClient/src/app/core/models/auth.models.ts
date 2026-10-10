export interface RegisterRequest {
  username: string;
  email: string;
  password: string;
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface AuthResponse {
  tokenType: string;
  accessToken: string;
  expiresInSeconds: number;
}

export interface RegisterResponse {
  message: string;
}

export interface AuthenticatedUser {
  userId: string;
  username: string;
  email: string;
}

export interface AuthErrorResponse {
  errors?: string[] | Record<string, string[]>;
  title?: string;
}