import { DatePipe } from '@angular/common';
import {
  afterNextRender,
  Component,
  DestroyRef,
  ElementRef,
  inject,
  Injector,
  input,
  OnInit,
  output,
  signal,
  ViewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { catchError, distinctUntilChanged, finalize, of, Subject, switchMap, timer } from 'rxjs';
import { User } from '../../../users/models/user';
import { UsersApiService } from '../../../users/data-access/users-api.service';
import { ConversationSummary, MessageSearchResult, UserPresence } from '../../models/conversation.model';
import { ConversationsApiService } from '../../services/conversations-api.service';

type SidebarMode = 'conversations' | 'messages' | 'friends';

@Component({
  selector: 'app-chat-sidebar',
  imports: [DatePipe, FormsModule],
  templateUrl: './chat-sidebar.component.html',
  styleUrl: './chat-sidebar.component.css',
})
export class ChatSidebarComponent implements OnInit {
  private readonly destroyRef = inject(DestroyRef);
  private readonly injector = inject(Injector);
  private readonly usersApi = inject(UsersApiService);
  private readonly conversationsApi = inject(ConversationsApiService);
  private readonly searchTerms = new Subject<string>();
  private readonly messageSearchTerms = new Subject<{ query: string; page: number; immediate: boolean }>();
  @ViewChild('messageSearchAction') private messageSearchAction?: ElementRef<HTMLButtonElement>;
  @ViewChild('friendSearchAction') private friendSearchAction?: ElementRef<HTMLButtonElement>;
  @ViewChild('messageSearchInput') private messageSearchInput?: ElementRef<HTMLInputElement>;
  @ViewChild('friendSearchInput') private friendSearchInput?: ElementRef<HTMLInputElement>;

  readonly mode = signal<SidebarMode>('conversations');
  readonly currentUserId = input<string | null>(null);
  readonly selectedFriend = input<User | null>(null);
  readonly selectedConversationId = input<number | null>(null);
  readonly conversations = input<ConversationSummary[]>([]);
  readonly presenceByUserId = input<Record<string, UserPresence>>({});
  readonly conversationsLoading = input(false);
  readonly conversationsError = input<string | null>(null);
  readonly openingConversation = input(false);
  readonly friendSelected = output<User>();
  readonly conversationSelected = output<ConversationSummary>();
  readonly retryConversations = output<void>();
  readonly messageResultSelected = output<MessageSearchResult>();
  readonly friends = signal<User[]>([]);
  readonly searching = signal(false);
  readonly searchError = signal<string | null>(null);
  readonly messageSearchResults = signal<MessageSearchResult[]>([]);
  readonly searchingMessages = signal(false);
  readonly messageSearchError = signal<string | null>(null);
  readonly messageSearchHasMore = signal(false);
  readonly failedMessageSearchPage = signal<number | null>(null);
  searchQuery = '';
  messageSearchQuery = '';
  private currentMessageSearchPage = 0;

  ngOnInit(): void {
    this.searchTerms.pipe(
      distinctUntilChanged(),
      switchMap((query) => {
        const username = query.trim();
        this.searchError.set(null);

        if (!username) {
          this.searching.set(false);
          return of([] as User[]);
        }

        this.searching.set(true);
        return timer(250).pipe(
          switchMap(() => this.usersApi.searchUsers(username)),
          catchError(() => {
            this.searchError.set('Could not search users. Try again.');
            return of([] as User[]);
          }),
          finalize(() => this.searching.set(false)),
        );
      }),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe((friends) => this.friends.set(friends));

    this.messageSearchTerms.pipe(
      switchMap(({ query, page, immediate }) => timer(!immediate && page === 1 && query ? 300 : 0).pipe(
        switchMap(() => {
          if (!query) {
            this.searchingMessages.set(false);
            return of({ query, page, response: null, error: null });
          }

          return this.conversationsApi.searchMessages(query, page).pipe(
            switchMap((response) => of({ query, page, response, error: null })),
            catchError(() => of({
              query,
              page,
              response: null,
              error: 'Could not search messages. Try again.',
            })),
          );
        }),
      )),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe(({ query, page, response, error }) => {
      if (query !== this.messageSearchQuery.trim()) {
        return;
      }

      this.searchingMessages.set(false);
      this.messageSearchError.set(error);
      this.failedMessageSearchPage.set(error ? page : null);
      if (!response) {
        return;
      }

      this.currentMessageSearchPage = page;
      this.messageSearchResults.update((current) => page === 1
        ? response.results
        : [...current, ...response.results]);
      this.messageSearchHasMore.set(response.hasMore);
    });
  }

  searchFriends(query: string): void {
    this.searchTerms.next(query);
  }

  searchMessages(query: string): void {
    this.messageSearchQuery = query;
    this.currentMessageSearchPage = 0;
    this.messageSearchResults.set([]);
    this.messageSearchHasMore.set(false);
    this.messageSearchError.set(null);
    this.failedMessageSearchPage.set(null);
    const normalizedQuery = query.trim();
    this.searchingMessages.set(Boolean(normalizedQuery));
    this.messageSearchTerms.next({ query: normalizedQuery, page: 1, immediate: false });
  }

  handleMessageSearchInput(event: Event): void {
    this.searchMessages((event.target as HTMLInputElement).value);
  }

  clearMessageSearch(): void {
    this.searchMessagesNow('');
    this.messageSearchInput?.nativeElement.focus({ preventScroll: true });
  }

  retryMessageSearch(): void {
    const page = this.failedMessageSearchPage();
    const query = this.messageSearchQuery.trim();
    if (!page || !query) {
      return;
    }

    this.searchingMessages.set(true);
    this.messageSearchError.set(null);
    this.failedMessageSearchPage.set(null);
    this.messageSearchTerms.next({ query, page, immediate: true });
  }

  submitMessageSearch(event: Event): void {
    event.preventDefault();
    this.searchMessagesNow(this.messageSearchQuery);
  }

  handleEscape(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || this.mode() === 'conversations') {
      return;
    }

    event.preventDefault();
    if (this.mode() === 'messages' && this.messageSearchQuery.trim()) {
      this.clearMessageSearch();
      return;
    }

    if (this.mode() === 'friends' && this.searchQuery.trim()) {
      this.searchQuery = '';
      this.friends.set([]);
      this.searchTerms.next('');
      this.friendSearchInput?.nativeElement.focus({ preventScroll: true });
      return;
    }

    this.returnToConversations();
  }

  openMessageSearch(): void {
    this.mode.set('messages');
    afterNextRender({
      write: () => this.messageSearchInput?.nativeElement.focus({ preventScroll: true }),
    }, { injector: this.injector });
  }

  openFriendSearch(): void {
    this.mode.set('friends');
    afterNextRender({
      write: () => this.friendSearchInput?.nativeElement.focus({ preventScroll: true }),
    }, { injector: this.injector });
  }

  returnToConversations(restoreFocus = true): void {
    const previousMode = this.mode();
    if (previousMode === 'messages') {
      this.searchMessagesNow('');
    } else if (previousMode === 'friends') {
      this.searchQuery = '';
      this.friends.set([]);
      this.searchError.set(null);
      this.searchTerms.next('');
    }

    this.mode.set('conversations');
    if (restoreFocus) {
      afterNextRender({
        write: () => (previousMode === 'messages'
          ? this.messageSearchAction?.nativeElement
          : this.friendSearchAction?.nativeElement)?.focus({ preventScroll: true }),
      }, { injector: this.injector });
    }
  }

  loadMoreMessageResults(): void {
    if (this.searchingMessages() || !this.messageSearchHasMore() || !this.messageSearchQuery.trim()) {
      return;
    }

    this.searchingMessages.set(true);
    this.messageSearchError.set(null);
    this.failedMessageSearchPage.set(null);
    this.messageSearchTerms.next({
      query: this.messageSearchQuery.trim(),
      page: this.currentMessageSearchPage + 1,
      immediate: true,
    });
  }

  selectMessageResult(result: MessageSearchResult): void {
    this.messageResultSelected.emit(result);
    this.returnToConversations(false);
  }

  selectFriend(friend: User): void {
    this.returnToConversations(false);
    this.friendSelected.emit(friend);
  }

  selectConversation(conversation: ConversationSummary): void {
    this.conversationSelected.emit(conversation);
  }

  highlightedSnippet(content: string): { text: string; matched: boolean }[] {
    const query = this.messageSearchQuery.trim();
    if (!query) {
      return [{ text: content, matched: false }];
    }

    const matcher = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    const parts: { text: string; matched: boolean }[] = [];
    let offset = 0;
    for (const match of content.matchAll(matcher)) {
      const index = match.index ?? 0;
      if (index > offset) {
        parts.push({ text: content.slice(offset, index), matched: false });
      }
      parts.push({ text: match[0], matched: true });
      offset = index + match[0].length;
    }

    if (offset < content.length) {
      parts.push({ text: content.slice(offset), matched: false });
    }
    return parts.length ? parts : [{ text: content, matched: false }];
  }

  private searchMessagesNow(query: string): void {
    this.messageSearchQuery = query;
    this.currentMessageSearchPage = 0;
    this.messageSearchResults.set([]);
    this.messageSearchHasMore.set(false);
    this.messageSearchError.set(null);
    this.failedMessageSearchPage.set(null);
    const normalizedQuery = query.trim();
    this.searchingMessages.set(Boolean(normalizedQuery));
    this.messageSearchTerms.next({ query: normalizedQuery, page: 1, immediate: true });
  }
}