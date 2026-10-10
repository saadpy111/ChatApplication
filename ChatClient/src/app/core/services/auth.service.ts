import { computed, inject, Injectable, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, tap } from 'rxjs';
import {
  AuthResponse,
  AuthenticatedUser,
  LoginRequest,
  RegisterRequest,
  RegisterResponse,
} from '../models/auth.models';

interface JwtPayload {
  sub?: unknown;
  name?: unknown;
  email?: unknown;
  exp?: unknown;
}

interface ParsedToken {
  user: AuthenticatedUser;
  expiresAt: number;
}

const TOKEN_STORAGE_KEY = 'chat-auth-token';
const AUTH_API_URL = '/api/auth';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);
  private readonly token = signal<string | null>(null);
  private readonly tokenExpiresAt = signal<number | null>(null);

  readonly currentUser = signal<AuthenticatedUser | null>(null);
  readonly isAuthenticated = computed(() => this.currentUser() !== null);

  constructor() {
    this.restoreSession();
  }

  register(request: RegisterRequest): Observable<RegisterResponse> {
    return this.http.post<RegisterResponse>(`${AUTH_API_URL}/register`, request);
  }

  login(request: LoginRequest): Observable<AuthResponse> {
    return this.http.post<AuthResponse>(`${AUTH_API_URL}/login`, request).pipe(
      tap((response) => {
        const parsedToken = this.parseToken(response.accessToken);
        if (!parsedToken) {
          this.clearSession();
          throw new Error('The server returned an invalid authentication token.');
        }

        this.storage()?.setItem(TOKEN_STORAGE_KEY, response.accessToken);
        this.setSession(response.accessToken, parsedToken);
      }),
    );
  }

  logout(): void {
    this.clearSession();
  }

  getToken(): string | null {
    const expiresAt = this.tokenExpiresAt();
    if (expiresAt !== null && expiresAt <= Date.now() / 1000) {
      this.clearSession();
      return null;
    }

    return this.token();
  }

  private restoreSession(): void {
    const token = this.storage()?.getItem(TOKEN_STORAGE_KEY);
    const parsedToken = token ? this.parseToken(token) : null;
    if (token && parsedToken) {
      this.setSession(token, parsedToken);
    } else if (token) {
      this.clearSession();
    }
  }

  private parseToken(token: string): ParsedToken | null {
    try {
      const encodedPayload = token.split('.')[1];
      if (!encodedPayload) {
        return null;
      }

      const base64 = encodedPayload.replace(/-/g, '+').replace(/_/g, '/');
      const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
      const payload = JSON.parse(new TextDecoder().decode(bytes)) as JwtPayload;
      if (
        typeof payload.sub !== 'string' ||
        typeof payload.name !== 'string' ||
        typeof payload.email !== 'string' ||
        typeof payload.exp !== 'number' ||
        payload.exp <= Date.now() / 1000
      ) {
        return null;
      }

      return {
        user: { userId: payload.sub, username: payload.name, email: payload.email },
        expiresAt: payload.exp,
      };
    } catch {
      return null;
    }
  }

  private clearSession(): void {
    this.storage()?.removeItem(TOKEN_STORAGE_KEY);
    this.token.set(null);
    this.tokenExpiresAt.set(null);
    this.currentUser.set(null);
  }

  private setSession(token: string, parsedToken: ParsedToken): void {
    this.token.set(token);
    this.tokenExpiresAt.set(parsedToken.expiresAt);
    this.currentUser.set(parsedToken.user);
  }

  private storage(): Storage | null {
    try {
      return typeof window === 'undefined' ? null : window.sessionStorage;
    } catch {
      return null;
    }
  }
}