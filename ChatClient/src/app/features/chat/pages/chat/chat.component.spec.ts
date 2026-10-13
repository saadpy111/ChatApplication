import { TestBed } from '@angular/core/testing';
import { Subject, of, throwError } from 'rxjs';
import { vi } from 'vitest';
import { AuthService } from '../../../../core/services/auth.service';
import { User } from '../../../users/models/user';
import { PersistedMessage } from '../../models/conversation.model';
import { ChatService } from '../../services/chatService';
import { ConversationsApiService } from '../../services/conversations-api.service';
import { ChatComponent } from './chat.component';
import { signal } from '@angular/core';

describe('ChatComponent message receipts', () => {
  const incomingMessages = new Subject<PersistedMessage>();
  const statusUpdates = new Subject<PersistedMessage>();
  const unreadCountUpdates = new Subject<{ conversationId: number; unreadCount: number }>();
  const reconnected = new Subject<void>();
  const userTyping = new Subject<{ conversationId: number; userId: string; displayName: string }>();
  const userStoppedTyping = new Subject<{ conversationId: number; userId: string }>();
  const connectionLost = new Subject<void>();
  const startTyping = vi.fn();
  const stopTyping = vi.fn();
  const sendMessage = vi.fn();
  const acknowledgeDelivered = vi.fn();
  const reconcilePendingDeliveries = vi.fn();
  const historicalMessages: PersistedMessage[] = [
    {
      id: 101,
      conversationId: 42,
      senderId: 'user-b',
      content: 'Offline message',
      createdAt: '2026-10-11T12:00:00Z',
      deliveredAt: null,
      readAt: null,
    },
    {
      id: 102,
      conversationId: 42,
      senderId: 'user-a',
      content: 'My outgoing message',
      createdAt: '2026-10-11T12:01:00Z',
      deliveredAt: null,
      readAt: null,
    },
    {
      id: 103,
      conversationId: 42,
      senderId: 'user-b',
      content: 'Already delivered',
      createdAt: '2026-10-11T12:02:00Z',
      deliveredAt: '2026-10-11T12:03:00Z',
      readAt: null,
    },
  ];
  let fixture: ReturnType<typeof TestBed.createComponent<ChatComponent>>;
  let component: ChatComponent;
  let getMessages: ReturnType<typeof vi.fn>;
  let getMessageContext: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    sendMessage.mockReset();
    acknowledgeDelivered.mockReset();
    reconcilePendingDeliveries.mockReset();
    startTyping.mockReset();
    stopTyping.mockReset();
    getMessages = vi.fn(() => of({ messages: historicalMessages, nextCursor: null, hasMore: false }));
    getMessageContext = vi.fn(() => of({ messages: historicalMessages, nextCursor: null, hasMore: false }));
    await TestBed.configureTestingModule({
      imports: [ChatComponent],
      providers: [
        {
          provide: AuthService,
          useValue: { currentUser: signal({ userId: 'user-a', username: 'alice', email: 'alice@example.test' }) },
        },
        {
          provide: ChatService,
          useValue: {
            incomingMessages$: incomingMessages.asObservable(),
            messageStatusUpdates$: statusUpdates.asObservable(),
            unreadCountUpdates$: unreadCountUpdates.asObservable(),
            reconnected$: reconnected.asObservable(),
            userTyping$: userTyping.asObservable(),
            userStoppedTyping$: userStoppedTyping.asObservable(),
            connectionLost$: connectionLost.asObservable(),
            status: signal('connected'),
            error: signal(null),
            startConnection: vi.fn().mockResolvedValue(undefined),
            sendMessage,
            startTyping,
            stopTyping,
            acknowledgeDelivered,
            reconcilePendingDeliveries,
            acknowledgeRead: vi.fn(),
          },
        },
        {
          provide: ConversationsApiService,
          useValue: {
            getConversations: () => of([]),
            getMessages,
            getMessageContext,
          },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(ChatComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    await fixture.whenStable();
    component.selectedConversationId.set(42);
    component.selectedFriend.set({ userId: 'user-b', username: 'bob' } satisfies User);
  });

  afterEach(() => {
    fixture.destroy();
    vi.useRealTimers();
  });

  it('deduplicates the broadcast and invocation result and keeps an early receipt update', async () => {
    const message: PersistedMessage = {
      id: 7,
      conversationId: 42,
      senderId: 'user-a',
      content: 'hello',
      createdAt: new Date().toISOString(),
      deliveredAt: null,
      readAt: null,
    };
    const deliveredMessage = { ...message, deliveredAt: new Date().toISOString() };
    statusUpdates.next(deliveredMessage);
    incomingMessages.next(message);
    sendMessage.mockResolvedValue(message);

    await component.sendMessage({ requestId: 1, conversationId: 42, text: 'hello' });

    expect(component.messages()).toHaveLength(1);
    expect(component.messages()[0]?.id).toBe(7);
    expect(component.messages()[0]?.deliveredAt).toBe(deliveredMessage.deliveredAt);
    expect(acknowledgeDelivered).not.toHaveBeenCalled();
  });

  it('acknowledges delivery only for an incoming message', () => {
    incomingMessages.next({
      id: 8,
      conversationId: 42,
      senderId: 'user-b',
      content: 'hi',
      createdAt: new Date().toISOString(),
      deliveredAt: null,
      readAt: null,
    });

    expect(acknowledgeDelivered).toHaveBeenCalledExactlyOnceWith(8);
  });

  it('acknowledges only undelivered incoming messages loaded from history', async () => {
    component.openExistingConversation({
      conversationId: 42,
      otherUserId: 'user-b',
      otherUsername: 'bob',
      lastMessagePreview: null,
      lastMessageAt: null,
      createdAt: '2026-10-11T11:00:00Z',
      unreadCount: 0,
    });
    await fixture.whenStable();

    expect(acknowledgeDelivered).toHaveBeenCalledExactlyOnceWith(101);
    expect(component.messages().map((message) => message.id)).toEqual([101, 102, 103]);
  });

  it('opens a search result by loading its historical context', async () => {
    getMessageContext.mockReturnValue(of({
      messages: historicalMessages,
      nextCursor: 'older-cursor',
      hasMore: true,
    }));

    component.openMessageResult({
      messageId: 101,
      conversationId: 42,
      content: 'Offline message',
      senderId: 'user-b',
      senderDisplayName: 'bob',
      otherUserId: 'user-b',
      otherUsername: 'bob',
      createdAt: '2026-10-11T12:00:00Z',
    });
    await fixture.whenStable();

    expect(getMessageContext).toHaveBeenCalledExactlyOnceWith(42, 101);
    expect(component.selectedConversationId()).toBe(42);
    expect(component.selectedMessageId()).toBe(101);
    expect(component.messages().map((message) => message.id)).toEqual([101, 102, 103]);
    expect(component.hasMore()).toBe(true);
    expect(fixture.nativeElement.querySelector('#message-101.search-highlight')).not.toBeNull();
  });

  it('reports an unavailable search message without loading the latest page instead', async () => {
    getMessageContext.mockReturnValue(throwError(() => new Error('history unavailable')));

    component.openMessageResult({
      messageId: 999,
      conversationId: 42,
      content: 'Missing message',
      senderId: 'user-b',
      senderDisplayName: 'bob',
      otherUserId: 'user-b',
      otherUsername: 'bob',
      createdAt: '2026-10-11T12:00:00Z',
    });
    await fixture.whenStable();

    expect(getMessages).not.toHaveBeenCalled();
    expect(component.messages()).toEqual([]);
    expect(component.navigationNotice()).toContain('unavailable or could not be loaded');
    expect(component.selectedMessageId()).toBeNull();
    expect(fixture.nativeElement.textContent).toContain('Could not open that message.');
  });

  it('keeps only the latest target when search results are selected before context responses finish', async () => {
    const firstResponse = new Subject<{
      messages: PersistedMessage[];
      nextCursor: string | null;
      hasMore: boolean;
    }>();
    const secondResponse = new Subject<{
      messages: PersistedMessage[];
      nextCursor: string | null;
      hasMore: boolean;
    }>();
    getMessageContext.mockReturnValueOnce(firstResponse).mockReturnValueOnce(secondResponse);

    component.openMessageResult({
      messageId: 101,
      conversationId: 42,
      content: 'Older result',
      senderId: 'user-b',
      senderDisplayName: 'bob',
      otherUserId: 'user-b',
      otherUsername: 'bob',
      createdAt: '2026-10-11T12:00:00Z',
    });
    component.openMessageResult({
      messageId: 202,
      conversationId: 43,
      content: 'Latest result',
      senderId: 'user-c',
      senderDisplayName: 'cara',
      otherUserId: 'user-c',
      otherUsername: 'cara',
      createdAt: '2026-10-11T13:00:00Z',
    });

    secondResponse.next({
      messages: [{
        id: 202,
        conversationId: 43,
        senderId: 'user-c',
        content: 'Latest result',
        createdAt: '2026-10-11T13:00:00Z',
        deliveredAt: null,
        readAt: null,
      }],
      nextCursor: null,
      hasMore: false,
    });
    await fixture.whenStable();
    firstResponse.next({ messages: historicalMessages, nextCursor: null, hasMore: false });
    await fixture.whenStable();

    expect(component.selectedConversationId()).toBe(43);
    expect(component.selectedMessageId()).toBe(202);
    expect(component.messages().map((message) => message.id)).toEqual([202]);
  });

  it('rejects a context response that does not contain the selected message', async () => {
    getMessageContext.mockReturnValue(of({
      messages: historicalMessages,
      nextCursor: null,
      hasMore: false,
    }));

    component.openMessageResult({
      messageId: 999,
      conversationId: 42,
      content: 'Missing result',
      senderId: 'user-b',
      senderDisplayName: 'bob',
      otherUserId: 'user-b',
      otherUsername: 'bob',
      createdAt: '2026-10-11T14:00:00Z',
    });
    await fixture.whenStable();

    expect(component.messages()).toEqual([]);
    expect(component.selectedMessageId()).toBeNull();
    expect(component.navigationNotice()).toContain('unavailable or could not be loaded');
    expect(getMessages).not.toHaveBeenCalled();
  });

  it('requests pending-delivery reconciliation after the sidebar list loads', async () => {
    await fixture.whenStable();

    expect(reconcilePendingDeliveries).toHaveBeenCalledExactlyOnceWith();
  });

  it('applies authoritative unread counts without incrementing duplicate events', () => {
    component.conversations.set([{
      conversationId: 42,
      otherUserId: 'user-b',
      otherUsername: 'bob',
      lastMessagePreview: 'hello',
      lastMessageAt: '2026-10-11T12:00:00Z',
      createdAt: '2026-10-11T11:00:00Z',
      unreadCount: 1,
    }]);
    const update = { conversationId: 42, unreadCount: 3 };

    unreadCountUpdates.next(update);
    unreadCountUpdates.next(update);

    expect(component.conversations()[0]?.unreadCount).toBe(3);
  });

  it('shows only the selected other participant and expires typing state', () => {
    vi.useFakeTimers();
    userTyping.next({ conversationId: 42, userId: 'user-b', displayName: 'bob' });
    expect(component.typingUsername()).toBe('bob');

    userTyping.next({ conversationId: 43, userId: 'user-b', displayName: 'bob' });
    userTyping.next({ conversationId: 42, userId: 'user-a', displayName: 'alice' });
    expect(component.typingUsername()).toBe('bob');

    vi.advanceTimersByTime(5000);
    expect(component.typingUsername()).toBeNull();
  });

  it('clears typing on stop, conversation switch, and connection loss', () => {
    userTyping.next({ conversationId: 42, userId: 'user-b', displayName: 'bob' });
    userStoppedTyping.next({ conversationId: 42, userId: 'user-b' });
    expect(component.typingUsername()).toBeNull();

    userTyping.next({ conversationId: 42, userId: 'user-b', displayName: 'bob' });
    component.showConversationListOnMobile();
    expect(component.typingUsername()).toBeNull();

    component.selectedConversationId.set(42);
    component.selectedFriend.set({ userId: 'user-b', username: 'bob' });
    userTyping.next({ conversationId: 42, userId: 'user-b', displayName: 'bob' });
    connectionLost.next();
    expect(component.typingUsername()).toBeNull();
  });

  it('stops an active typing state when the chat page is destroyed', () => {
    component.handleTypingStarted(42);
    expect(startTyping).toHaveBeenCalledExactlyOnceWith(42);

    fixture.destroy();

    expect(stopTyping).toHaveBeenCalledExactlyOnceWith(42);
  });
});