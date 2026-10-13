import { Component, DestroyRef, inject, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { firstValueFrom } from 'rxjs';
import { ChatMessage, MessageActionState, MessageSendRequest, MessageSendResult } from '../../models/chat-message.model';
import {
  ConversationSummary,
  MessagePage,
  MessageSearchResult,
  PersistedMessage,
  UnreadCountUpdate,
  UserPresence,
} from '../../models/conversation.model';
import { ChatConversationComponent } from '../../components/chat-conversation/chat-conversation.component';
import { ChatSidebarComponent } from '../../components/chat-sidebar/chat-sidebar.component';
import { User } from '../../../users/models/user';
import { ChatService, UserStoppedTypingEvent, UserTypingEvent } from '../../services/chatService';
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
  readonly messageActionStates = signal<Record<number, MessageActionState>>({});
  readonly typingUsername = signal<string | null>(null);
  readonly conversationsLoading = signal(true);
  readonly conversationsError = signal<string | null>(null);
  readonly initialLoading = signal(false);
  readonly loadingOlder = signal(false);
  readonly historyError = signal<string | null>(null);
  readonly navigationNotice = signal<string | null>(null);
  readonly selectedMessageId = signal<number | null>(null);
  readonly messageNavigationVersion = signal(0);
  readonly hasMore = signal(false);
  readonly olderPageVersion = signal(0);
  readonly openingConversation = signal(false);
  readonly showConversationOnMobile = signal(false);
  private nextCursor: string | null = null;
  private conversationLoadVersion = 0;
  private conversationsLoadVersion = 0;
  private readonly pendingStatusUpdates = new Map<number, PersistedMessage>();
  private readonly pendingUnreadCountUpdates = new Map<number, { unreadCount: number; version: number }>();
  private unreadCountVersion = 0;
  private typingIndicatorTimeout: ReturnType<typeof setTimeout> | null = null;
  private readonly typingIndicatorTimeoutMs = 5000;
  private activeTypingConversationId: number | null = null;

  ngOnInit(): void {
    this.chatService.incomingMessages$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((message) => this.receiveMessage(message));
    this.chatService.messageStatusUpdates$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((message) => this.updateMessageStatus(message));
    this.chatService.messageEdits$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((message) => this.applyMessageMutation(message));
    this.chatService.messageDeletes$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((message) => this.applyMessageMutation(message));
    this.chatService.unreadCountUpdates$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((update) => this.updateUnreadCount(update));
    this.chatService.reconnected$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => void this.reconcileAfterReconnect());
    this.chatService.userTyping$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((event) => this.receiveTypingStarted(event));
    this.chatService.userStoppedTyping$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((event) => this.receiveTypingStopped(event));
    this.chatService.connectionLost$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.clearTypingIndicator());
    this.destroyRef.onDestroy(() => {
      this.clearTypingIndicator();
      if (this.activeTypingConversationId !== null) {
        this.chatService.stopTyping(this.activeTypingConversationId);
        this.activeTypingConversationId = null;
      }
    });

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
    this.clearTypingIndicator();
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

  openMessageResult(result: MessageSearchResult): void {
    this.selectedMessageId.set(null);
    this.messageNavigationVersion.update((version) => version + 1);
    this.navigationNotice.set(null);
    void this.activateConversation(result.conversationId, {
      userId: result.otherUserId,
      username: result.otherUsername,
    }, result.messageId);
  }

  handleSearchNavigationFailed(event: {
    conversationId: number;
    messageId: number;
    requestVersion: number;
  }): void {
    if (this.selectedConversationId() !== event.conversationId ||
        this.selectedMessageId() !== event.messageId ||
        this.messageNavigationVersion() !== event.requestVersion) {
      return;
    }

    this.selectedMessageId.set(null);
    this.navigationNotice.set('The selected message could not be displayed. Please choose the result again.');
  }

  showConversationListOnMobile(): void {
    this.clearTypingIndicator();
    this.showConversationOnMobile.set(false);
  }

  handleTypingStarted(conversationId: number): void {
    this.activeTypingConversationId = conversationId;
    this.chatService.startTyping(conversationId);
  }

  handleTypingStopped(conversationId: number): void {
    if (this.activeTypingConversationId === conversationId) {
      this.activeTypingConversationId = null;
    }
    this.chatService.stopTyping(conversationId);
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

  presenceForSelectedFriend(): UserPresence | null {
    const userId = this.selectedFriend()?.userId;
    return userId ? this.chatService.presenceByUserId()[userId] ?? null : null;
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

  async editMessage(request: { conversationId: number; messageId: number; content: string }): Promise<void> {
    if (this.selectedConversationId() !== request.conversationId) {
      return;
    }

    this.setMessageActionState(request.messageId, { pending: true, error: null });
    try {
      const message = await firstValueFrom(this.conversationsApi.editMessage(
        request.conversationId, request.messageId, request.content,
      ));
      this.applyMessageMutation(message);
      this.setMessageActionState(request.messageId, null);
    } catch {
      this.setMessageActionState(request.messageId, {
        pending: false,
        error: 'This message could not be edited. Try again.',
      });
    }
  }

  async deleteMessage(request: { conversationId: number; messageId: number }): Promise<void> {
    if (this.selectedConversationId() !== request.conversationId) {
      return;
    }

    this.setMessageActionState(request.messageId, { pending: true, error: null });
    try {
      const message = await firstValueFrom(this.conversationsApi.deleteMessage(
        request.conversationId, request.messageId,
      ));
      this.applyMessageMutation(message);
      this.setMessageActionState(request.messageId, null);
    } catch {
      this.setMessageActionState(request.messageId, {
        pending: false,
        error: 'This message could not be deleted. Try again.',
      });
    }
  }

  private async activateConversation(
    conversationId: number,
    friend: User,
    targetMessageId?: number,
  ): Promise<void> {
    this.clearTypingIndicator();
    const loadVersion = ++this.conversationLoadVersion;
    this.showConversationOnMobile.set(true);
    this.selectedConversationId.set(conversationId);
    this.selectedFriend.set(friend);
    this.messages.set([]);
    this.messageActionStates.set({});
    this.selectedMessageId.set(null);
    this.nextCursor = null;
    this.hasMore.set(false);
    this.loadingOlder.set(false);
    this.initialLoading.set(true);
    this.historyError.set(null);

    try {
      const page = await firstValueFrom(targetMessageId
        ? this.conversationsApi.getMessageContext(conversationId, targetMessageId)
        : this.conversationsApi.getMessages(conversationId));
      if (this.selectedConversationId() !== conversationId || this.conversationLoadVersion !== loadVersion) {
        return;
      }

      if (targetMessageId && !page.messages.some((message) => message.id === targetMessageId)) {
        throw new Error('The selected message is not present in its history context.');
      }

      this.replaceMessagePage(page, friend);
      if (targetMessageId && page.messages.some((message) => message.id === targetMessageId)) {
        this.selectedMessageId.set(targetMessageId);
      }
    } catch {
      if (this.selectedConversationId() === conversationId && this.conversationLoadVersion === loadVersion) {
        if (targetMessageId) {
          this.selectedMessageId.set(null);
          this.navigationNotice.set('That message is unavailable or could not be loaded. Select the result again to retry.');
        } else {
          this.historyError.set('Messages could not be loaded. Retry to try again.');
        }
      }
    } finally {
      if (this.selectedConversationId() === conversationId && this.conversationLoadVersion === loadVersion) {
        this.initialLoading.set(false);
      }
    }
  }

  private replaceMessagePage(page: MessagePage, friend: User): void {
    this.messages.set(page.messages.map((message) => this.toChatMessage(message, friend)));
    this.acknowledgeUndeliveredMessages(page.messages);
    this.nextCursor = page.nextCursor;
    this.hasMore.set(page.hasMore);
  }

  private async loadConversations(): Promise<void> {
    const loadVersion = ++this.conversationsLoadVersion;
    const unreadUpdateVersion = this.unreadCountVersion;
    this.conversationsLoading.set(true);
    this.conversationsError.set(null);
    try {
      const conversations = await firstValueFrom(this.conversationsApi.getConversations());
      if (this.conversationsLoadVersion === loadVersion) {
        this.chatService.setConversationPresence(conversations);
        this.conversations.set(conversations.map((conversation) => {
          const update = this.pendingUnreadCountUpdates.get(conversation.conversationId);
          return update && update.version > unreadUpdateVersion
            ? { ...conversation, unreadCount: update.unreadCount }
            : conversation;
        }));
        this.pendingUnreadCountUpdates.clear();
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

    this.messages.update((current) => current.map((item) => item.id === message.id
      ? {
          ...item,
          deliveredAt: message.deliveredAt ?? item.deliveredAt ?? null,
          readAt: message.readAt ?? item.readAt ?? null,
        }
      : item));
  }

  private applyMessageMutation(message: PersistedMessage): void {
    if (this.selectedConversationId() === message.conversationId
      && this.messages().some((item) => item.id === message.id)) {
      this.messages.update((current) => this.mergeMessages(current, [message]));
    }
    void this.loadConversations();
  }

  private setMessageActionState(messageId: number, state: MessageActionState | null): void {
    this.messageActionStates.update((current) => {
      const next = { ...current };
      if (state) {
        next[messageId] = state;
      } else {
        delete next[messageId];
      }
      return next;
    });
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

  private updateUnreadCount(update: UnreadCountUpdate): void {
    const version = ++this.unreadCountVersion;
    this.pendingUnreadCountUpdates.set(update.conversationId, {
      unreadCount: update.unreadCount,
      version,
    });

    if (!this.conversations().some((item) => item.conversationId === update.conversationId)) {
      void this.loadConversations();
      return;
    }

    this.conversations.update((items) => items.map((item) =>
      item.conversationId === update.conversationId
        ? { ...item, unreadCount: update.unreadCount }
        : item,
    ));
  }

  private receiveTypingStarted(event: UserTypingEvent): void {
    const conversationId = this.selectedConversationId();
    const friend = this.selectedFriend();
    const currentUserId = this.authService.currentUser()?.userId;
    if (event.conversationId !== conversationId || !friend
      || event.userId !== friend.userId || event.userId === currentUserId) {
      return;
    }

    this.typingUsername.set(event.displayName);
    this.clearTypingIndicatorTimeout();
    this.typingIndicatorTimeout = setTimeout(
      () => this.clearTypingIndicator(),
      this.typingIndicatorTimeoutMs,
    );
  }

  private receiveTypingStopped(event: UserStoppedTypingEvent): void {
    const friend = this.selectedFriend();
    if (event.conversationId === this.selectedConversationId() && friend?.userId === event.userId) {
      this.clearTypingIndicator();
    }
  }

  private clearTypingIndicator(): void {
    this.clearTypingIndicatorTimeout();
    this.typingUsername.set(null);
  }

  private clearTypingIndicatorTimeout(): void {
    if (this.typingIndicatorTimeout !== null) {
      clearTimeout(this.typingIndicatorTimeout);
      this.typingIndicatorTimeout = null;
    }
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
      const pendingStatus = this.pendingStatusUpdates.get(received.id);
      this.pendingStatusUpdates.delete(received.id);
      const converted = this.toChatMessage(received, friend);
      const existing = byId.get(received.id);
      const existingEditedAt = existing?.editedAt ?? null;
      const receivedEditedAt = converted.editedAt ?? null;
      const keepExistingEdit = existingEditedAt !== null
        && (!receivedEditedAt || Date.parse(existingEditedAt) > Date.parse(receivedEditedAt));
      const isDeleted = existing?.isDeleted === true || converted.isDeleted === true;
      byId.set(received.id, {
        ...converted,
        text: isDeleted ? '' : keepExistingEdit ? existing?.text ?? converted.text : converted.text,
        editedAt: keepExistingEdit ? existing?.editedAt : converted.editedAt,
        deletedAt: existing?.isDeleted ? existing.deletedAt : converted.deletedAt,
        isDeleted,
        deliveredAt: converted.deliveredAt ?? pendingStatus?.deliveredAt ?? existing?.deliveredAt ?? null,
        readAt: converted.readAt ?? pendingStatus?.readAt ?? existing?.readAt ?? null,
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
      editedAt: message.editedAt,
      deletedAt: message.deletedAt,
      isDeleted: message.isDeleted ?? Boolean(message.deletedAt),
      deliveredAt: message.deliveredAt,
      readAt: message.readAt,
    };
  }
}