import { Component, DestroyRef, inject, input, OnInit, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { catchError, debounceTime, distinctUntilChanged, finalize, of, Subject, switchMap } from 'rxjs';
import { User } from '../../../users/models/user';
import { UsersApiService } from '../../../users/data-access/users-api.service';

@Component({
  selector: 'app-chat-sidebar',
  imports: [FormsModule],
  templateUrl: './chat-sidebar.component.html',
  styleUrl: './chat-sidebar.component.css',
})
export class ChatSidebarComponent implements OnInit {
  private readonly destroyRef = inject(DestroyRef);
  private readonly usersApi = inject(UsersApiService);
  private readonly searchTerms = new Subject<string>();

  readonly selectedFriend = input<User | null>(null);
  readonly friendSelected = output<User>();
  readonly friends = signal<User[]>([]);
  readonly searching = signal(false);
  readonly searchError = signal<string | null>(null);
  searchQuery = '';

  ngOnInit(): void {
    this.searchTerms.pipe(
      debounceTime(250),
      distinctUntilChanged(),
      switchMap((query) => {
        const username = query.trim();
        this.searchError.set(null);

        if (!username) {
          this.searching.set(false);
          return of([] as User[]);
        }

        this.searching.set(true);
        return this.usersApi.searchUsers(username).pipe(
          catchError(() => {
            this.searchError.set('Could not search users. Try again.');
            return of([] as User[]);
          }),
          finalize(() => this.searching.set(false)),
        );
      }),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe((friends) => this.friends.set(friends));
  }

  searchFriends(query: string): void {
    this.searchTerms.next(query);
  }

  selectFriend(friend: User): void {
    this.friendSelected.emit(friend);
  }
}