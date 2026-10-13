import { TestBed } from '@angular/core/testing';
import { Observable, of, Subject, throwError } from 'rxjs';
import { vi } from 'vitest';
import { ConversationsApiService } from '../../services/conversations-api.service';
import { UsersApiService } from '../../../users/data-access/users-api.service';
import { User } from '../../../users/models/user';
import { ChatSidebarComponent } from './chat-sidebar.component';

describe('ChatSidebarComponent', () => {
  let fixture: ReturnType<typeof TestBed.createComponent<ChatSidebarComponent>>;
  let searchMessages: ReturnType<typeof vi.fn>;
  let searchUsers: ReturnType<typeof vi.fn>;
  let responses: Subject<{ results: ReturnType<typeof searchResult>[]; page: number; pageSize: number; hasMore: boolean }>[];

  function searchResult(messageId: number, content = 'matching message') {
    return {
      messageId,
      conversationId: 42,
      content,
      senderId: 'user-b',
      senderDisplayName: 'bob',
      otherUserId: 'user-b',
      otherUsername: 'bob',
      createdAt: '2026-10-11T12:00:00Z',
    };
  }

  beforeEach(async () => {
    responses = [];
    searchUsers = vi.fn(() => of([]));
    searchMessages = vi.fn((_query: string, page: number) => {
      const response = new Subject<{
        results: ReturnType<typeof searchResult>[];
        page: number;
        pageSize: number;
        hasMore: boolean;
      }>();
      responses.push(response);
      return response as Observable<{
        results: ReturnType<typeof searchResult>[];
        page: number;
        pageSize: number;
        hasMore: boolean;
      }>;
    });
    await TestBed.configureTestingModule({
      imports: [ChatSidebarComponent],
      providers: [
        { provide: UsersApiService, useValue: { searchUsers } },
        { provide: ConversationsApiService, useValue: { searchMessages } },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(ChatSidebarComponent);
  });

  afterEach(() => {
    fixture.destroy();
    vi.useRealTimers();
  });

  function emitPage(index: number, messageIds: number[], page: number, hasMore: boolean, content?: string): void {
    responses[index]?.next({
      results: messageIds.map((id) => searchResult(id, content)),
      page,
      pageSize: 20,
      hasMore,
    });
  }

  async function openMessageSearch(): Promise<void> {
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('button[aria-label="Search messages"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    await fixture.whenStable();
  }

  function renderUnreadCount(unreadCount: number): HTMLElement {
    fixture.componentRef.setInput('conversations', [{
      conversationId: 42,
      otherUserId: 'user-b',
      otherUsername: 'مونا with a long username',
      lastMessagePreview: 'مرحبا',
      lastMessageAt: null,
      createdAt: '2026-10-11T11:00:00Z',
      unreadCount,
    }]);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  it('hides the badge when there are no unread messages', () => {
    const root = renderUnreadCount(0);

    expect(root.querySelector('.unread-badge')).toBeNull();
  });

  it('shows counts and compacts large values accessibly', () => {
    const root = renderUnreadCount(120);
    const badge = root.querySelector('.unread-badge');

    expect(badge?.textContent?.trim()).toBe('99+');
    expect(badge?.getAttribute('aria-label')).toBe('120 unread messages');
  });

  it('shows only one sidebar mode and moves focus into and back from search', async () => {
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.conversation-list')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.message-search-input')).toBeNull();

    await openMessageSearch();
    await fixture.whenStable();
    const input = fixture.nativeElement.querySelector('.message-search-input') as HTMLInputElement;
    expect(fixture.nativeElement.querySelector('.conversation-list')).toBeNull();
    expect(fixture.nativeElement.querySelector('.message-results')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.friend-search-panel')).toBeNull();
    expect(input.ownerDocument.activeElement).toBe(input);

    (fixture.nativeElement.querySelector('.back-button') as HTMLButtonElement).click();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('.conversation-list')).not.toBeNull();
    expect(input.ownerDocument.activeElement?.getAttribute('aria-label')).toBe('Search messages');
  });

  it('keeps friend search separate from message search', async () => {
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('button[aria-label="Find a friend"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    await fixture.whenStable();

    expect(fixture.nativeElement.querySelector('.friend-search-panel')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.message-search-input')).toBeNull();
    expect(fixture.nativeElement.querySelector('.conversation-list')).toBeNull();

    const friendInput = fixture.nativeElement.querySelector('[aria-label="Search by username"]') as HTMLInputElement;
    friendInput.value = 'alice';
    friendInput.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.waitFor(() => expect(searchUsers).toHaveBeenCalledWith('alice'));

    (fixture.nativeElement.querySelector('.back-button') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.conversation-list')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.message-results')).toBeNull();
  });

  it('cancels a friend-search response when returning to chats', async () => {
    vi.useFakeTimers();
    fixture.detectChanges();
    const pendingResponse = new Subject<User[]>();
    searchUsers.mockReturnValue(pendingResponse);
    fixture.componentInstance.openFriendSearch();
    fixture.detectChanges();
    fixture.componentInstance.searchFriends('mona');
    await vi.advanceTimersByTimeAsync(250);
    expect(searchUsers).toHaveBeenCalledExactlyOnceWith('mona');

    fixture.componentInstance.returnToConversations();
    pendingResponse.next([{ userId: 'user-b', username: 'mona' }]);

    expect(fixture.componentInstance.friends()).toEqual([]);
    expect(fixture.componentInstance.mode()).toBe('conversations');
  });

  it('debounces message queries and displays matching results', async () => {
    vi.useFakeTimers();
    await openMessageSearch();

    fixture.componentInstance.searchMessages('match');
    fixture.detectChanges();
    expect(fixture.componentInstance.searchingMessages()).toBe(true);
    await vi.advanceTimersByTimeAsync(299);
    expect(searchMessages).not.toHaveBeenCalled();
    expect(fixture.nativeElement.textContent).toContain('Searching messages...');

    await vi.advanceTimersByTimeAsync(1);
    expect(searchMessages).toHaveBeenCalledExactlyOnceWith('match', 1);
    emitPage(0, [11], 1, false);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('matching message');
    expect(fixture.nativeElement.textContent).toContain('bob');
  });

  it('submits immediately with Enter and safely highlights matching text', async () => {
    openMessageSearch();
    const input = fixture.nativeElement.querySelector('.message-search-input') as HTMLInputElement;
    input.value = 'match';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    fixture.detectChanges();
    expect(fixture.componentInstance.messageSearchQuery).toBe('match');

    const submit = new Event('submit', { cancelable: true });
    fixture.componentInstance.submitMessageSearch(submit);
    expect(submit.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(searchMessages).toHaveBeenCalledExactlyOnceWith('match', 1));
    emitPage(0, [11], 1, false, '<img src=x onerror=alert(1)> MATCH phrase');
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.result-match')?.textContent).toBe('MATCH');
    expect(fixture.nativeElement.querySelector('img')).toBeNull();
    expect(fixture.nativeElement.textContent).toContain('<img src=x onerror=alert(1)> MATCH phrase');
  });

  it('uses Escape to clear a query first and return to chats when empty', async () => {
    await openMessageSearch();
    const input = fixture.nativeElement.querySelector('.message-search-input') as HTMLInputElement;
    fixture.componentInstance.searchMessages('term');
    fixture.detectChanges();
    const aside = fixture.nativeElement.querySelector('.sidebar') as HTMLElement;
    aside.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    fixture.detectChanges();

    expect(fixture.componentInstance.mode()).toBe('messages');
    expect(fixture.componentInstance.messageSearchQuery).toBe('');
    expect(input.ownerDocument.activeElement).toBe(input);

    aside.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    fixture.detectChanges();
    expect(fixture.componentInstance.mode()).toBe('conversations');
  });

  it('cancels stale responses, clears results, and paginates', async () => {
    vi.useFakeTimers();
    await openMessageSearch();

    fixture.componentInstance.searchMessages('old');
    await vi.advanceTimersByTimeAsync(300);
    fixture.componentInstance.searchMessages('new');
    await vi.advanceTimersByTimeAsync(300);
    emitPage(1, [22], 1, true);
    emitPage(0, [11], 1, false);
    expect(fixture.componentInstance.messageSearchResults().map((result) => result.messageId)).toEqual([22]);

    fixture.detectChanges();
    (fixture.nativeElement.querySelector('.load-more-results') as HTMLButtonElement).click();
    await vi.advanceTimersByTimeAsync(0);
    expect(searchMessages).toHaveBeenLastCalledWith('new', 2);
    emitPage(2, [23], 2, false);
    expect(fixture.componentInstance.messageSearchResults().map((result) => result.messageId)).toEqual([22, 23]);

    fixture.detectChanges();
    (fixture.nativeElement.querySelector('.clear-search') as HTMLButtonElement).click();
    expect(fixture.componentInstance.messageSearchResults()).toEqual([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.componentInstance.searchingMessages()).toBe(false);
    expect(searchMessages).toHaveBeenCalledTimes(3);
  });

  it('shows empty and error states', async () => {
    vi.useFakeTimers();
    await openMessageSearch();
    fixture.componentInstance.searchMessages('none');
    await vi.advanceTimersByTimeAsync(300);
    emitPage(0, [], 1, false);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('No messages found');

    searchMessages.mockImplementationOnce(() => throwError(() => new Error('request failed')));
    fixture.componentInstance.searchMessages('error');
    await vi.advanceTimersByTimeAsync(300);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Could not search messages. Try again.');
  });

  it('retries the page that failed while loading more results', async () => {
    vi.useFakeTimers();
    await openMessageSearch();
    fixture.componentInstance.searchMessages('term');
    await vi.advanceTimersByTimeAsync(300);
    emitPage(0, [1], 1, true);
    fixture.detectChanges();

    searchMessages.mockImplementationOnce(() => throwError(() => new Error('page failed')));
    (fixture.nativeElement.querySelector('.load-more-results') as HTMLButtonElement).click();
    await vi.advanceTimersByTimeAsync(0);
    fixture.detectChanges();
    expect(searchMessages).toHaveBeenLastCalledWith('term', 2);

    (fixture.nativeElement.querySelector('.retry-link') as HTMLButtonElement).click();
    await vi.advanceTimersByTimeAsync(0);
    expect(searchMessages).toHaveBeenLastCalledWith('term', 2);
  });
});