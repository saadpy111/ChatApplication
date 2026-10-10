import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { UsersApiService } from './users-api.service';

describe('UsersApiService', () => {
  let service: UsersApiService;
  let httpTesting: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(UsersApiService);
    httpTesting = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpTesting.verify());

  it('searches users by username', () => {
    service.searchUsers('sam lee').subscribe();

    const request = httpTesting.expectOne('/api/users/search?username=sam%20lee');
    expect(request.request.method).toBe('GET');
    request.flush([]);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});