import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import {
  ConversationSummary,
  MessagePage,
  MessageSearchPage,
  OpenConversation,
} from '../models/conversation.model';

@Injectable({ providedIn: 'root' })
export class ConversationsApiService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = '/api/conversations';

  getConversations(): Observable<ConversationSummary[]> {
    return this.http.get<ConversationSummary[]>(this.baseUrl);
  }

  openConversation(otherUserId: string): Observable<OpenConversation> {
    return this.http.post<OpenConversation>(`${this.baseUrl}/open/${encodeURIComponent(otherUserId)}`, {});
  }

  getMessages(conversationId: number, pageSize = 30, before?: string): Observable<MessagePage> {
    let params = new HttpParams().set('pageSize', pageSize);
    if (before) {
      params = params.set('before', before);
    }

    return this.http.get<MessagePage>(`${this.baseUrl}/${conversationId}/messages`, { params });
  }

  getMessageContext(conversationId: number, messageId: number): Observable<MessagePage> {
    return this.http.get<MessagePage>(
      `${this.baseUrl}/${conversationId}/messages/${messageId}/context`,
    );
  }

  searchMessages(query: string, page = 1, pageSize = 20): Observable<MessageSearchPage> {
    const params = new HttpParams()
      .set('q', query)
      .set('page', page)
      .set('pageSize', pageSize);
    return this.http.get<MessageSearchPage>(`${this.baseUrl}/search/messages`, { params });
  }
}