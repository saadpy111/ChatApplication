import { Routes } from '@angular/router';
import { ChatComponent } from './features/chat/pages/chat/chat.component';

export const routes: Routes = [
	{ path: '', pathMatch: 'full', redirectTo: 'chat' },
	{ path: 'chat', component: ChatComponent },
];
