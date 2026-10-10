import { HttpErrorResponse } from '@angular/common/http';
import { Component, inject, signal } from '@angular/core';
import { AbstractControl, FormBuilder, ReactiveFormsModule, ValidationErrors, ValidatorFn, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { AuthErrorResponse } from '../../../../core/models/auth.models';
import { AuthService } from '../../../../core/services/auth.service';

const passwordsMatchValidator: ValidatorFn = (control: AbstractControl): ValidationErrors | null => {
  const password = control.get('password')?.value;
  const confirmPassword = control.get('confirmPassword')?.value;
  return password === confirmPassword ? null : { passwordMismatch: true };
};

@Component({
  selector: 'app-register',
  imports: [ReactiveFormsModule, RouterLink],
  templateUrl: './register.html',
  styleUrl: './register.css',
})
export class RegisterComponent {
  private readonly formBuilder = inject(FormBuilder);
  private readonly auth = inject(AuthService);

  readonly form = this.formBuilder.nonNullable.group(
    {
      username: ['', [Validators.required, Validators.minLength(3), Validators.maxLength(32)]],
      email: ['', [Validators.required, Validators.email, Validators.maxLength(256)]],
      password: ['', [Validators.required, Validators.minLength(8), Validators.maxLength(100)]],
      confirmPassword: ['', [Validators.required]],
    },
    { validators: passwordsMatchValidator },
  );
  readonly isSubmitting = signal(false);
  readonly passwordVisible = signal(false);
  readonly confirmationVisible = signal(false);
  readonly serverError = signal<string | null>(null);
  readonly registrationComplete = signal(false);

  submit(): void {
    this.form.markAllAsTouched();
    this.serverError.set(null);
    if (this.form.invalid || this.isSubmitting()) {
      return;
    }

    const { username, email, password } = this.form.getRawValue();
    this.isSubmitting.set(true);
    this.auth.register({ username, email, password }).subscribe({
      next: () => this.registrationComplete.set(true),
      error: (error: unknown) => {
        this.serverError.set(this.errorMessage(error, 'Unable to create your account. Please try again.'));
        this.isSubmitting.set(false);
      },
      complete: () => this.isSubmitting.set(false),
    });
  }

  private errorMessage(error: unknown, fallback: string): string {
    if (!(error instanceof HttpErrorResponse)) {
      return fallback;
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