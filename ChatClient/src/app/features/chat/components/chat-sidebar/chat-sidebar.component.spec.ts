import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { vi } from 'vitest';
import { UsersApiService } from '../../../users/data-access/users-api.service';
import { ChatSidebarComponent } from './chat-sidebar.component';

describe('ChatSidebarComponent unread badges', () => {
  let fixture: ReturnType<typeof TestBed.createComponent<ChatSidebarComponent>>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ChatSidebarComponent],
      providers: [{ provide: UsersApiService, useValue: { searchUsers: vi.fn(() => of([])) } }],
    }).compileComponents();

    fixture = TestBed.createComponent(ChatSidebarComponent);
  });

  afterEach(() => fixture.destroy());

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
});