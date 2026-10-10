import { Routes } from '@angular/router';
import { ChatComponent } from './features/chat/pages/chat/chat.component';
import { LoginComponent } from './features/auth/pages/login/login';
import { RegisterComponent } from './features/auth/pages/register/register';
import { authGuard } from './core/guards/auth.guard';

export const routes: Routes = [
	{ path: 'auth/login', component: LoginComponent },
	{ path: 'auth/register', component: RegisterComponent },
	{ path: '', pathMatch: 'full', redirectTo: 'chat' },
	{ path: 'chat', component: ChatComponent, canActivate: [authGuard] },
	{ path: '**', redirectTo: 'chat' },
];
