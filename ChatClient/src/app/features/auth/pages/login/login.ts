import { HttpErrorResponse } from '@angular/common/http';
import { Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { AuthErrorResponse } from '../../../../core/models/auth.models';
import { AuthService } from '../../../../core/services/auth.service';

@Component({
  selector: 'app-login',
  imports: [ReactiveFormsModule, RouterLink],
  templateUrl: './login.html',
  styleUrl: './login.css',
})
export class LoginComponent {
  private readonly formBuilder = inject(FormBuilder);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  readonly form = this.formBuilder.nonNullable.group({
    username: ['', [Validators.required]],
    password: ['', [Validators.required, Validators.minLength(8)]],
  });
  readonly isSubmitting = signal(false);
  readonly passwordVisible = signal(false);
  readonly serverError = signal<string | null>(null);
  readonly registrationComplete = this.route.snapshot.queryParamMap.get('registered') === 'true';

  submit(): void {
    this.form.markAllAsTouched();
    this.serverError.set(null);
    if (this.form.invalid || this.isSubmitting()) {
      return;
    }

    this.isSubmitting.set(true);
    this.auth.login(this.form.getRawValue()).subscribe({
      next: () => {
        const returnUrl = this.route.snapshot.queryParamMap.get('returnUrl');
        const destination = returnUrl?.startsWith('/') && !returnUrl.startsWith('//') ? returnUrl : '/chat';
        void this.router.navigateByUrl(destination);
      },
      error: (error: unknown) => {
        this.serverError.set(this.errorMessage(error, 'Unable to sign in. Please try again.'));
        this.isSubmitting.set(false);
      },
      complete: () => this.isSubmitting.set(false),
    });
  }

  private errorMessage(error: unknown, fallback: string): string {
    if (!(error instanceof HttpErrorResponse)) {
      return fallback;
    }

    if (error.status === 401) {
      return 'The username or password is incorrect.';
    }

    const body = error.error as AuthErrorResponse | null;
    if (Array.isArray(body?.errors)) {
      return body.errors.join(' ');
    }
    if (body?.errors && typeof body.errors === 'object') {
      return Object.values(body.errors).flat().join(' ');
    }
    return body?.title ?? fallback;
  }
}