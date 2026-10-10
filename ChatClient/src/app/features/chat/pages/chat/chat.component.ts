import { Component, DestroyRef, inject, OnInit, signal } from '@angular/core';
import { ChatMessage } from '../../models/chat-message.model';
import { ChatConversationComponent } from '../../components/chat-conversation/chat-conversation.component';
import { ChatSidebarComponent } from '../../components/chat-sidebar/chat-sidebar.component';
import { User } from '../../../users/models/user';
import { ChatService } from '../../services/chatService';

@Component({
  selector: 'app-chat',
  imports: [ChatSidebarComponent, ChatConversationComponent],
  templateUrl: './chat.component.html',
  styleUrl: './chat.component.css',
})
export class ChatComponent implements OnInit {
  private readonly destroyRef = inject(DestroyRef);
  readonly chatService = inject(ChatService);
  readonly selectedFriend = signal<User | null>(null);
  readonly messages = signal<ChatMessage[]>([]);
  readonly sending = signal(false);

  ngOnInit(): void {
    const unsubscribe = this.chatService.onReceiveMessage((text) => {
      if (!this.selectedFriend()) {
        return;
      }

      this.messages.update((messages) => [
        ...messages,
        { id: this.nextMessageId++, text, sender: 'friend', sentAt: new Date() },
      ]);
    });
    this.destroyRef.onDestroy(unsubscribe);

    void this.connect();
  }

  private nextMessageId = 0;

  async connect(): Promise<void> {
    try {
      await this.chatService.startConnection();
    } catch {
      // Connection state and the error message are exposed by the chat service.
    }
  }

  openConversation(friend: User): void {
    if (this.selectedFriend()?.userId !== friend.userId) {
      this.messages.set([]);
    }
    this.selectedFriend.set(friend);
  }

  async sendMessage(text: string): Promise<void> {
    const friend = this.selectedFriend();
    if (!friend || this.sending() || this.chatService.status() !== 'connected') {
      return;
    }

    this.sending.set(true);
    this.chatService.error.set(null);

    try {
      await this.chatService.sendMessage(friend.userId, text);
      if (this.selectedFriend()?.userId !== friend.userId) {
        return;
      }

      this.messages.update((messages) => [
        ...messages,
        { id: this.nextMessageId++, text, sender: 'me', sentAt: new Date() },
      ]);
    } catch {
      this.chatService.error.set('Your message could not be sent. Try again.');
    } finally {
      this.sending.set(false);
    }
  }
}