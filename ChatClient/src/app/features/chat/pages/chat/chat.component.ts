import { DatePipe } from '@angular/common';
import { Component, DestroyRef, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { catchError, debounceTime, distinctUntilChanged, finalize, of, Subject, switchMap } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { UsersApiService } from '../../../users/data-access/users-api.service';
import { User } from '../../../users/models/user';

@Component({
  selector: 'app-chat',
  imports: [FormsModule],
  templateUrl: './chat.component.html',
  styleUrl: './chat.component.css',
})
export class ChatComponent implements OnInit {
  private readonly destroyRef = inject(DestroyRef);
  private readonly usersApi = inject(UsersApiService);
  private readonly searchTerms = new Subject<string>();

  searchQuery = '';
  readonly friends = signal<User[]>([]);
  readonly selectedFriend = signal<User | null>(null);
  readonly searching = signal(false);
  readonly searchError = signal<string | null>(null);

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

  openConversation(friend: User): void {
    this.selectedFriend.set(friend);
  }
}