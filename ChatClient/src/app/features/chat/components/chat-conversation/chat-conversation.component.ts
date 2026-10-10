import { DatePipe } from '@angular/common';
import { Component, input, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ChatConnectionStatus, ChatMessage } from '../../models/chat-message.model';
import { User } from '../../../users/models/user';

@Component({
  selector: 'app-chat-conversation',
  imports: [DatePipe, FormsModule],
  templateUrl: './chat-conversation.component.html',
  styleUrl: './chat-conversation.component.css',
})
export class ChatConversationComponent {
  readonly friend = input<User | null>(null);
  readonly messages = input<ChatMessage[]>([]);
  readonly connectionStatus = input<ChatConnectionStatus>('disconnected');
  readonly connectionError = input<string | null>(null);
  readonly sending = input(false);
  readonly messageSubmitted = output<string>();
  readonly retryConnection = output<void>();

  draft = '';

  send(): void {
    const message = this.draft.trim();
    if (!message || this.sending() || this.connectionStatus() !== 'connected') {
      return;
    }

    this.messageSubmitted.emit(message);
    this.draft = '';
  }

  handleEnter(event: Event): void {
    const keyboardEvent = event as KeyboardEvent;
    if (!keyboardEvent.shiftKey) {
      keyboardEvent.preventDefault();
      this.send();
    }
  }
}