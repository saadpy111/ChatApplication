import { DatePipe, DOCUMENT } from '@angular/common';
import { AfterViewChecked, afterNextRender, Component, DestroyRef, ElementRef, inject, Injector, input, OnChanges, output, signal, SimpleChanges, ViewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ChatConnectionStatus, ChatMessage, MessageSendRequest, MessageSendResult } from '../../models/chat-message.model';
import { User } from '../../../users/models/user';

@Component({
  selector: 'app-chat-conversation',
  imports: [DatePipe, FormsModule],
  templateUrl: './chat-conversation.component.html',
  styleUrl: './chat-conversation.component.css',
})
export class ChatConversationComponent implements AfterViewChecked, OnChanges {
  private readonly destroyRef = inject(DestroyRef);
  private readonly document = inject(DOCUMENT);
  private readonly injector = inject(Injector);
  private readObserver: IntersectionObserver | null = null;
  private readonly observedMessages = new Set<Element>();
  private readonly visibleIncomingMessageIds = new Set<number>();
  private lastReadBoundary: { id: number; sentAt: number } | null = null;
  private pendingSearchNavigation: { messageId: number; requestVersion: number } | null = null;
  private searchHighlightTimer: ReturnType<typeof setTimeout> | null = null;
  @ViewChild('messageList') private messageList?: ElementRef<HTMLElement>;
  @ViewChild('messageInput') private messageInput?: ElementRef<HTMLTextAreaElement>;
  @ViewChild('sendButton') private sendButton?: ElementRef<HTMLButtonElement>;

  readonly friend = input<User | null>(null);
  readonly conversationId = input<number | null>(null);
  readonly conversationActive = input(true);
  readonly messages = input<ChatMessage[]>([]);
  readonly initialLoading = input(false);
  readonly loadingOlder = input(false);
  readonly historyError = input<string | null>(null);
  readonly navigationNotice = input<string | null>(null);
  readonly highlightedMessageId = input<number | null>(null);
  readonly highlightRequestVersion = input(0);
  readonly activeSearchHighlightId = signal<number | null>(null);
  readonly hasMore = input(false);
  readonly olderPageVersion = input(0);
  readonly connectionStatus = input<ChatConnectionStatus>('disconnected');
  readonly connectionError = input<string | null>(null);
  readonly sending = input(false);
  readonly sendResult = input<MessageSendResult | null>(null);
  readonly currentUserId = input<string | null>(null);
  readonly currentUsername = input('');
  readonly typingUsername = input<string | null>(null);
  readonly messageSubmitted = output<MessageSendRequest>();
  readonly typingStarted = output<number>();
  readonly typingStopped = output<number>();
  readonly loadOlder = output<void>();
  readonly retryHistory = output<void>();
  readonly retryConnection = output<void>();
  readonly backToList = output<void>();
  readonly readAcknowledged = output<{ conversationId: number; lastReadMessageId: number }>();
  readonly searchNavigationFailed = output<{
    conversationId: number;
    messageId: number;
    requestVersion: number;
  }>();

  draft = '';
  private previousMessageCount = 0;
  private previousHistoryVersion = 0;
  private nearBottom = true;
  private preserveScroll = false;
  private previousScrollHeight = 0;
  private previousScrollTop = 0;
  private nextSendRequestId = 0;
  private pendingSend: { requestId: number; conversationId: number; draft: string } | null = null;
  private pendingConversationFocus: { conversationId: number; origin: Element | null } | null = null;
  private focusAfterSend: { requestId: number; conversationId: number } | null = null;
  private typingStopTimer: ReturnType<typeof setTimeout> | null = null;
  private activeTypingConversationId: number | null = null;
  private lastTypingNotificationAt = 0;
  private readonly typingInactivityMs = 1800;
  private readonly typingRefreshMs = 2500;

  constructor() {
    this.document.addEventListener('visibilitychange', this.handleDocumentVisibilityChange);
    this.destroyRef.onDestroy(() => {
      this.document.removeEventListener('visibilitychange', this.handleDocumentVisibilityChange);
      this.readObserver?.disconnect();
      this.clearTypingStopTimer();
      this.clearSearchHighlightTimer();
      this.pendingSearchNavigation = null;
      this.activeTypingConversationId = null;
    });
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['friend'] || changes['conversationId'] || changes['conversationActive']) {
      const conversationId = this.conversationId();
      if (!conversationId || !this.friend() || !this.conversationActive()
        || (this.activeTypingConversationId !== null && this.activeTypingConversationId !== conversationId)) {
        this.stopTyping();
      }
      if (conversationId && this.friend() && this.conversationActive()) {
        this.pendingConversationFocus = { conversationId, origin: this.document.activeElement };
      } else {
        this.pendingConversationFocus = null;
      }
    }
    if (changes['conversationId']) {
      this.readObserver?.disconnect();
      this.readObserver = null;
      this.observedMessages.clear();
      this.visibleIncomingMessageIds.clear();
      this.lastReadBoundary = null;
      this.clearSearchNavigation();
    }
    if (changes['highlightedMessageId'] || changes['highlightRequestVersion'] || changes['conversationActive']) {
      const messageId = this.highlightedMessageId();
      if (messageId === null) {
        this.clearSearchNavigation();
      } else if (this.conversationActive()) {
        this.clearSearchHighlightTimer();
        this.activeSearchHighlightId.set(null);
        this.pendingSearchNavigation = {
          messageId,
          requestVersion: this.highlightRequestVersion(),
        };
      }
    }

    const result = this.sendResult();
    const pendingSend = this.pendingSend;
    if (result && pendingSend && result.requestId === pendingSend.requestId) {
      this.pendingSend = null;
      if (result.succeeded) {
        this.stopTyping();
      }
      if (result.conversationId === pendingSend.conversationId && this.conversationId() === pendingSend.conversationId) {
        if (!result.succeeded) {
          this.draft = pendingSend.draft;
        }
        this.focusAfterSend = {
          requestId: pendingSend.requestId,
          conversationId: pendingSend.conversationId,
        };
      }
    }

    if (changes['sending'] || changes['sendResult']) {
      this.restoreComposerFocusAfterRender();
    }
  }

  ngAfterViewChecked(): void {
    this.focusConversationWhenReady();

    const element = this.messageList?.nativeElement;
    if (!element) {
      return;
    }

    const historyVersion = this.olderPageVersion();
    const messages = this.messages();
    if (this.preserveScroll && this.historyError() && !this.loadingOlder()) {
      this.preserveScroll = false;
    }
    if (historyVersion !== this.previousHistoryVersion) {
      this.previousHistoryVersion = historyVersion;
      if (this.preserveScroll) {
        element.scrollTop = this.previousScrollTop + element.scrollHeight - this.previousScrollHeight;
        this.preserveScroll = false;
      }
      this.previousMessageCount = messages.length;
      this.navigateToSearchResult(element);
      this.refreshReadTracking(element);
      return;
    }

    if (messages.length !== this.previousMessageCount) {
      if (messages.length > this.previousMessageCount && (this.previousMessageCount === 0 || this.nearBottom)) {
        element.scrollTop = element.scrollHeight;
      }
      this.previousMessageCount = messages.length;
    }
    this.navigateToSearchResult(element);
    this.refreshReadTracking(element);
  }

  private navigateToSearchResult(container: HTMLElement): void {
    const pending = this.pendingSearchNavigation;
    if (!pending || !this.conversationActive() || this.initialLoading()) {
      return;
    }

    const conversationId = this.conversationId();
    if (!conversationId || conversationId <= 0) {
      return;
    }

    const targetMessage = this.messages().find((message) => message.id === pending.messageId);
    if (!targetMessage) {
      this.failSearchNavigation(pending, conversationId);
      return;
    }

    const targetElement = container.querySelector<HTMLElement>(`#message-${pending.messageId}`);
    if (!targetElement) {
      this.failSearchNavigation(pending, conversationId);
      return;
    }

    this.pendingSearchNavigation = null;
    const containerRect = container.getBoundingClientRect();
    const targetRect = targetElement.getBoundingClientRect();
    const top = Math.max(0, container.scrollTop + targetRect.top - containerRect.top -
      (container.clientHeight - targetRect.height) / 2);
    container.scrollTop = top;

    this.activeSearchHighlightId.set(pending.messageId);
    this.clearSearchHighlightTimer();
    this.searchHighlightTimer = setTimeout(() => {
      if (this.highlightedMessageId() === pending.messageId &&
          this.highlightRequestVersion() === pending.requestVersion) {
        this.activeSearchHighlightId.set(null);
      }
      this.searchHighlightTimer = null;
    }, 2800);
  }

  private failSearchNavigation(
    pending: { messageId: number; requestVersion: number },
    conversationId: number,
  ): void {
    this.pendingSearchNavigation = null;
    this.searchNavigationFailed.emit({
      conversationId,
      messageId: pending.messageId,
      requestVersion: pending.requestVersion,
    });
  }

  private clearSearchNavigation(): void {
    this.pendingSearchNavigation = null;
    this.activeSearchHighlightId.set(null);
    this.clearSearchHighlightTimer();
  }

  private clearSearchHighlightTimer(): void {
    if (this.searchHighlightTimer !== null) {
      clearTimeout(this.searchHighlightTimer);
      this.searchHighlightTimer = null;
    }
  }

  handleScroll(event: Event): void {
    const element = event.currentTarget as HTMLElement;
    this.nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 90;
    if (element.scrollTop < 70 && this.hasMore() && !this.loadingOlder()) {
      this.preserveScroll = true;
      this.previousScrollHeight = element.scrollHeight;
      this.previousScrollTop = element.scrollTop;
      this.loadOlder.emit();
    }
  }

  send(): void {
    const message = this.draft.trim();
    const conversationId = this.conversationId();
    if (!message || !conversationId || this.sending() || this.connectionStatus() !== 'connected') {
      return;
    }

    const requestId = ++this.nextSendRequestId;
    this.pendingSend = { requestId, conversationId, draft: this.draft };
    this.draft = '';
    this.messageSubmitted.emit({ requestId, conversationId, text: message });
  }

  handleDraftInput(): void {
    const conversationId = this.conversationId();
    if (!this.draft.trim() || !conversationId || !this.conversationActive()) {
      this.stopTyping();
      return;
    }

    const now = Date.now();
    if (this.activeTypingConversationId !== conversationId
      || now - this.lastTypingNotificationAt >= this.typingRefreshMs) {
      this.activeTypingConversationId = conversationId;
      this.lastTypingNotificationAt = now;
      this.typingStarted.emit(conversationId);
    }

    this.clearTypingStopTimer();
    this.typingStopTimer = setTimeout(() => this.stopTyping(), this.typingInactivityMs);
  }

  handleEnter(event: Event): void {
    const keyboardEvent = event as KeyboardEvent;
    if (!keyboardEvent.shiftKey) {
      keyboardEvent.preventDefault();
      this.send();
    }
  }

  private stopTyping(): void {
    this.clearTypingStopTimer();
    const conversationId = this.activeTypingConversationId;
    this.activeTypingConversationId = null;
    this.lastTypingNotificationAt = 0;
    if (conversationId !== null) {
      this.typingStopped.emit(conversationId);
    }
  }

  private clearTypingStopTimer(): void {
    if (this.typingStopTimer !== null) {
      clearTimeout(this.typingStopTimer);
      this.typingStopTimer = null;
    }
  }

  private focusConversationWhenReady(): void {
    const pendingFocus = this.pendingConversationFocus;
    if (!pendingFocus) {
      return;
    }

    if (this.destroyRef.destroyed || this.conversationId() !== pendingFocus.conversationId || !this.friend() || !this.conversationActive()) {
      this.pendingConversationFocus = null;
      return;
    }

    const textarea = this.messageInput?.nativeElement;
    const activeElement = this.document.activeElement;
    const focusStillInOpeningFlow = activeElement === pendingFocus.origin
      || activeElement === this.document.body
      || activeElement === textarea;
    if (!focusStillInOpeningFlow) {
      this.pendingConversationFocus = null;
      return;
    }

    if (!textarea?.isConnected || textarea.disabled || this.connectionStatus() !== 'connected' || this.sending()) {
      return;
    }

    this.pendingConversationFocus = null;
    textarea.focus({ preventScroll: true });
  }

  private readonly handleDocumentVisibilityChange = (): void => {
    this.readObserver?.disconnect();
    this.readObserver = null;
    this.observedMessages.clear();
    this.refreshReadTracking(this.messageList?.nativeElement);
  };

  private refreshReadTracking(element: HTMLElement | undefined): void {
    if (!element || !this.conversationId() || this.document.visibilityState !== 'visible'
      || element.getClientRects().length === 0 || typeof IntersectionObserver === 'undefined') {
      this.readObserver?.disconnect();
      this.readObserver = null;
      this.observedMessages.clear();
      return;
    }

    if (!this.readObserver) {
      const observedConversationId = this.conversationId();
      this.readObserver = new IntersectionObserver((entries) => {
        if (this.conversationId() !== observedConversationId) {
          return;
        }

        for (const entry of entries) {
          const target = entry.target as HTMLElement;
          const messageId = Number(target.dataset['messageId']);
          if (entry.isIntersecting && entry.intersectionRatio > 0
            && target.dataset['incoming'] === 'true' && Number.isSafeInteger(messageId)) {
            this.visibleIncomingMessageIds.add(messageId);
          }
        }
        this.acknowledgeLatestVisibleMessage();
      }, { root: element, threshold: 0 });
    }

    for (const target of element.querySelectorAll<HTMLElement>('.message[data-message-id]')) {
      if (!this.observedMessages.has(target)) {
        this.observedMessages.add(target);
        this.readObserver.observe(target);
      }
    }
  }

  private acknowledgeLatestVisibleMessage(): void {
    const conversationId = this.conversationId();
    if (!conversationId || this.document.visibilityState !== 'visible') {
      return;
    }

    let latestVisible: ChatMessage | undefined;
    for (const message of this.messages()) {
      if (message.senderId !== this.currentUserId() && this.visibleIncomingMessageIds.has(message.id)
        && (!latestVisible || message.sentAt.getTime() > latestVisible.sentAt.getTime()
          || (message.sentAt.getTime() === latestVisible.sentAt.getTime() && message.id > latestVisible.id))) {
        latestVisible = message;
      }
    }

    if (!latestVisible) {
      return;
    }

    const sentAt = latestVisible.sentAt.getTime();
    const previous = this.lastReadBoundary;
    if (previous && (sentAt < previous.sentAt || (sentAt === previous.sentAt && latestVisible.id <= previous.id))) {
      return;
    }

    this.lastReadBoundary = { id: latestVisible.id, sentAt };
    this.readAcknowledged.emit({ conversationId, lastReadMessageId: latestVisible.id });
  }

  private restoreComposerFocusAfterRender(): void {
    const pendingFocus = this.focusAfterSend;
    if (!pendingFocus || this.sending()) {
      return;
    }

    afterNextRender({
      write: () => {
        if (this.destroyRef.destroyed || this.focusAfterSend !== pendingFocus) {
          return;
        }
        this.focusAfterSend = null;

        const textarea = this.messageInput?.nativeElement;
        if (!textarea?.isConnected || textarea.disabled || this.conversationId() !== pendingFocus.conversationId || !this.conversationActive()) {
          return;
        }

        const activeElement = textarea.ownerDocument.activeElement;
        const focusStillInComposer = activeElement === textarea
          || activeElement === textarea.ownerDocument.body
          || activeElement === this.sendButton?.nativeElement;
        if (focusStillInComposer) {
          textarea.focus({ preventScroll: true });
        }
      },
    }, { injector: this.injector });
  }
}