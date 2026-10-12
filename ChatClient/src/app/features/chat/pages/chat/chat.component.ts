import { Component, DestroyRef, inject, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { firstValueFrom } from 'rxjs';
import { ChatMessage, MessageSendRequest, MessageSendResult } from '../../models/chat-message.model';
import { ConversationSummary, MessagePage, PersistedMessage } from '../../models/conversation.model';
import { ChatConversationComponent } from '../../components/chat-conversation/chat-conversation.component';
import { ChatSidebarComponent } from '../../components/chat-sidebar/chat-sidebar.component';
import { User } from '../../../users/models/user';
import { ChatService } from '../../services/chatService';
import { ConversationsApiService } from '../../services/conversations-api.service';
import { AuthService } from '../../../../core/services/auth.service';

@Component({
  selector: 'app-chat',
  imports: [ChatSidebarComponent, ChatConversationComponent],
  templateUrl: './chat.component.html',
  styleUrl: './chat.component.css',
})
export class ChatComponent implements OnInit {
  private readonly destroyRef = inject(DestroyRef);
  readonly authService = inject(AuthService);
  readonly chatService = inject(ChatService);
  private readonly conversationsApi = inject(ConversationsApiService);
  readonly conversations = signal<ConversationSummary[]>([]);
  readonly selectedFriend = signal<User | null>(null);
  readonly selectedConversationId = signal<number | null>(null);
  readonly messages = signal<ChatMessage[]>([]);
  readonly sending = signal(false);
  readonly sendResult = signal<MessageSendResult | null>(null);
  readonly conversationsLoading = signal(true);
  readonly conversationsError = signal<string | null>(null);
  readonly initialLoading = signal(false);
  readonly loadingOlder = signal(false);
  readonly historyError = signal<string | null>(null);
  readonly hasMore = signal(false);
  readonly olderPageVersion = signal(0);
  readonly openingConversation = signal(false);
  readonly showConversationOnMobile = signal(false);
  private nextCursor: string | null = null;
  private conversationLoadVersion = 0;
  private conversationsLoadVersion = 0;
  private readonly pendingStatusUpdates = new Map<number, PersistedMessage>();

  ngOnInit(): void {
    this.chatService.incomingMessages$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((message) => this.receiveMessage(message));
    this.chatService.messageStatusUpdates$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((message) => this.updateMessageStatus(message));
    this.chatService.reconnected$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => void this.reconcileAfterReconnect());

    void this.loadConversations();
    void this.connect();
  }

  async connect(): Promise<void> {
    try {
      await this.chatService.startConnection();
    } catch {
      // Connection state and the error message are exposed by the chat service.
    }
  }

  async openConversation(friend: User): Promise<void> {
    this.showConversationOnMobile.set(true);
    this.selectedConversationId.set(null);
    this.selectedFriend.set(friend);
    this.messages.set([]);
    this.openingConversation.set(true);
    this.historyError.set(null);
    try {
      const opened = await firstValueFrom(this.conversationsApi.openConversation(friend.userId));
      await this.loadConversations();
      await this.activateConversation(opened.conversationId, {
        userId: opened.userId,
        username: opened.username,
      });
    } catch {
      this.historyError.set('Could not open this conversation. Try again.');
    } finally {
      this.openingConversation.set(false);
    }
  }

  openExistingConversation(conversation: ConversationSummary): void {
    void this.activateConversation(conversation.conversationId, {
      userId: conversation.otherUserId,
      username: conversation.otherUsername,
    });
  }

  showConversationListOnMobile(): void {
    this.showConversationOnMobile.set(false);
  }

  retryCurrentConversation(): void {
    const conversationId = this.selectedConversationId();
    const friend = this.selectedFriend();
    if (conversationId && friend) {
      void this.activateConversation(conversationId, friend);
    }
  }

  retryConversations(): void {
    void this.loadConversations();
  }

  async loadOlderMessages(): Promise<void> {
    const conversationId = this.selectedConversationId();
    const cursor = this.nextCursor;
    const loadVersion = this.conversationLoadVersion;
    if (!conversationId || !cursor || !this.hasMore() || this.loadingOlder()) {
      return;
    }

    this.loadingOlder.set(true);
    this.historyError.set(null);
    try {
      const page = await firstValueFrom(this.conversationsApi.getMessages(conversationId, 30, cursor));
      if (this.selectedConversationId() !== conversationId || this.conversationLoadVersion !== loadVersion) {
        return;
      }

      this.messages.update((current) => this.mergeMessages(current, page.messages));
      this.acknowledgeUndeliveredMessages(page.messages);
      this.nextCursor = page.nextCursor;
      this.hasMore.set(page.hasMore);
      this.olderPageVersion.update((version) => version + 1);
    } catch {
      if (this.selectedConversationId() === conversationId && this.conversationLoadVersion === loadVersion) {
        this.historyError.set('Older messages could not be loaded. Scroll up to retry.');
      }
    } finally {
      if (this.conversationLoadVersion === loadVersion) {
        this.loadingOlder.set(false);
      }
    }
  }

  async sendMessage(request: MessageSendRequest): Promise<void> {
    const { conversationId, requestId, text } = request;
    if (this.selectedConversationId() !== conversationId || this.sending() || this.chatService.status() !== 'connected') {
      this.sendResult.set({ requestId, conversationId, succeeded: false });
      return;
    }

    this.sending.set(true);
    this.chatService.error.set(null);

    try {
      const message = await this.chatService.sendMessage(conversationId, text);
      this.receiveMessage(message);
      this.sendResult.set({ requestId, conversationId, succeeded: true });
    } catch {
      await this.refreshAfterSendFailure(conversationId);
      this.chatService.error.set('The message could not be confirmed. Check the conversation before retrying.');
      this.sendResult.set({ requestId, conversationId, succeeded: false });
    } finally {
      this.sending.set(false);
    }
  }

  private async activateConversation(conversationId: number, friend: User): Promise<void> {
    const loadVersion = ++this.conversationLoadVersion;
    this.showConversationOnMobile.set(true);
    this.selectedConversationId.set(conversationId);
    this.selectedFriend.set(friend);
    this.messages.set([]);
    this.nextCursor = null;
    this.hasMore.set(false);
    this.loadingOlder.set(false);
    this.initialLoading.set(true);
    this.historyError.set(null);

    try {
      const page = await firstValueFrom(this.conversationsApi.getMessages(conversationId));
      if (this.selectedConversationId() !== conversationId || this.conversationLoadVersion !== loadVersion) {
        return;
      }

      this.messages.set(page.messages.map((message) => this.toChatMessage(message, friend)));
      this.acknowledgeUndeliveredMessages(page.messages);
      this.nextCursor = page.nextCursor;
      this.hasMore.set(page.hasMore);
    } catch {
      if (this.selectedConversationId() === conversationId && this.conversationLoadVersion === loadVersion) {
        this.historyError.set('Messages could not be loaded. Retry to try again.');
      }
    } finally {
      if (this.selectedConversationId() === conversationId && this.conversationLoadVersion === loadVersion) {
        this.initialLoading.set(false);
      }
    }
  }

  private async loadConversations(): Promise<void> {
    const loadVersion = ++this.conversationsLoadVersion;
    this.conversationsLoading.set(true);
    this.conversationsError.set(null);
    try {
      const conversations = await firstValueFrom(this.conversationsApi.getConversations());
      if (this.conversationsLoadVersion === loadVersion) {
        this.conversations.set(conversations);
        this.chatService.reconcilePendingDeliveries();
      }
    } catch {
      if (this.conversationsLoadVersion === loadVersion) {
        this.conversationsError.set('Conversations could not be loaded. Try again.');
      }
    } finally {
      if (this.conversationsLoadVersion === loadVersion) {
        this.conversationsLoading.set(false);
      }
    }
  }

  private receiveMessage(message: PersistedMessage): void {
    this.updateSidebar(message);
    const friend = this.selectedFriend();
    if (this.selectedConversationId() === message.conversationId && friend) {
      this.messages.update((current) => this.mergeMessages(current, [message], friend));
    }

    const currentUserId = this.authService.currentUser()?.userId;
    if (currentUserId && message.senderId !== currentUserId) {
      this.chatService.acknowledgeDelivered(message.id);
    }
  }

  private updateMessageStatus(message: PersistedMessage): void {
    if (this.selectedConversationId() !== message.conversationId) {
      return;
    }

    if (!this.messages().some((item) => item.id === message.id)) {
      const currentUserId = this.authService.currentUser()?.userId;
      if (message.senderId === currentUserId && Date.now() - Date.parse(message.createdAt) < 60_000) {
        this.pendingStatusUpdates.set(message.id, message);
      }
      return;
    }

    this.messages.update((current) => this.mergeMessages(current, [message]));
  }

  acknowledgeRead(acknowledgement: { conversationId: number; lastReadMessageId: number }): void {
    if (this.selectedConversationId() === acknowledgement.conversationId) {
      this.chatService.acknowledgeRead(
        acknowledgement.conversationId,
        acknowledgement.lastReadMessageId,
      );
    }
  }

  private acknowledgeUndeliveredMessages(messages: PersistedMessage[]): void {
    const currentUserId = this.authService.currentUser()?.userId;
    if (!currentUserId) {
      return;
    }

    for (const message of messages) {
      if (message.senderId !== currentUserId && !message.deliveredAt) {
        this.chatService.acknowledgeDelivered(message.id);
      }
    }
  }

  private updateSidebar(message: PersistedMessage): void {
    const existing = this.conversations().find((item) => item.conversationId === message.conversationId);
    if (!existing) {
      void this.loadConversations();
      return;
    }

    const updated = {
      ...existing,
      lastMessagePreview: message.content,
      lastMessageAt: message.createdAt,
    };
    this.conversations.update((items) => [
      updated,
      ...items.filter((item) => item.conversationId !== message.conversationId),
    ].sort((left, right) => {
      const leftDate = Date.parse(left.lastMessageAt ?? left.createdAt);
      const rightDate = Date.parse(right.lastMessageAt ?? right.createdAt);
      return rightDate - leftDate || right.conversationId - left.conversationId;
    }));
  }

  private async reconcileAfterReconnect(): Promise<void> {
    await this.loadConversations();
    const conversationId = this.selectedConversationId();
    const friend = this.selectedFriend();
    if (!conversationId || !friend) {
      return;
    }

    try {
      const page = await firstValueFrom(this.conversationsApi.getMessages(conversationId));
      if (this.selectedConversationId() === conversationId) {
        this.messages.update((current) => this.mergeMessages(current, page.messages, friend));
        this.acknowledgeUndeliveredMessages(page.messages);
      }
    } catch {
      this.historyError.set('Could not sync recent messages after reconnecting.');
    }
  }

  private async refreshAfterSendFailure(conversationId: number): Promise<void> {
    const friend = this.selectedFriend();
    if (!friend || this.selectedConversationId() !== conversationId) {
      return;
    }

    try {
      const page: MessagePage = await firstValueFrom(this.conversationsApi.getMessages(conversationId));
      if (this.selectedConversationId() === conversationId) {
        this.messages.update((current) => this.mergeMessages(current, page.messages, friend));
        this.nextCursor = this.nextCursor ?? page.nextCursor;
        this.hasMore.set(this.hasMore() || page.hasMore);
      }
    } catch {
      // Keep the send error visible if history is unavailable too.
    }
  }

  private mergeMessages(
    current: ChatMessage[],
    incoming: PersistedMessage[],
    friend = this.selectedFriend(),
  ): ChatMessage[] {
    if (!friend) {
      return current;
    }

    const byId = new Map(current.map((message) => [message.id, message]));
    for (const received of incoming) {
      const message = this.pendingStatusUpdates.get(received.id) ?? received;
      this.pendingStatusUpdates.delete(received.id);
      const converted = this.toChatMessage(message, friend);
      const existing = byId.get(message.id);
      byId.set(message.id, {
        ...converted,
        deliveredAt: converted.deliveredAt ?? received.deliveredAt ?? existing?.deliveredAt ?? null,
        readAt: converted.readAt ?? received.readAt ?? existing?.readAt ?? null,
      });
    }

    return [...byId.values()].sort((left, right) =>
      left.sentAt.getTime() - right.sentAt.getTime() || left.id - right.id,
    );
  }

  private toChatMessage(message: PersistedMessage, friend: User): ChatMessage {
    return {
      id: message.id,
      text: message.content,
      senderId: message.senderId,
      sentAt: new Date(message.createdAt),
      deliveredAt: message.deliveredAt,
      readAt: message.readAt,
    };
  }
}