import type { FastifyInstance } from 'fastify';
import type { Notifier, ControlEvent, DocEvent } from '../../src/services/notifier.js';
import { TEST_ORIGIN } from './env.js';

/** Records every notification instead of publishing it. */
export class RecordingNotifier implements Notifier {
  readonly docEvents: Array<{ docId: string; event: DocEvent }> = [];
  readonly controlEvents: ControlEvent[] = [];

  doc(docId: string, event: DocEvent): void {
    this.docEvents.push({ docId, event });
  }

  control(event: ControlEvent): void {
    this.controlEvents.push(event);
  }
}

export interface ApiResponse {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  headers: Record<string, unknown>;
  cookies: Array<{ name: string; value: string }>;
}

/** Sends JSON requests through `inject` with the expected origin and an optional session. */
export class ApiClient {
  readonly app: FastifyInstance;
  cookie: string | null = null;

  constructor(app: FastifyInstance) {
    this.app = app;
  }

  async request(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<ApiResponse> {
    const mutating = method !== 'GET';
    const response = await this.app.inject({
      method,
      url,
      headers: {
        ...(mutating ? { 'content-type': 'application/json', origin: TEST_ORIGIN } : {}),
        ...(this.cookie ? { cookie: `cd_session=${this.cookie}` } : {}),
        ...headers,
      },
      ...(mutating ? { payload: JSON.stringify(body ?? {}) } : {}),
    });
    const text = response.body;
    return {
      status: response.statusCode,
      body: text.length > 0 ? JSON.parse(text) : null,
      headers: response.headers,
      cookies: response.cookies.map((cookie) => ({ name: cookie.name, value: cookie.value })),
    };
  }

  get(url: string) {
    return this.request('GET', url);
  }

  post(url: string, body?: unknown) {
    return this.request('POST', url, body);
  }

  patch(url: string, body?: unknown) {
    return this.request('PATCH', url, body);
  }

  delete(url: string) {
    return this.request('DELETE', url);
  }
}

export interface TestUser {
  id: string;
  email: string;
  name: string;
  api: ApiClient;
  /** The raw session token, for WebSocket cookies. */
  token: string;
  personalWorkspaceId: string;
}

/** Registers a user through the API and returns a client signed in as them. */
export async function registerUser(app: FastifyInstance, name: string): Promise<TestUser> {
  const api = new ApiClient(app);
  const email = `${name.toLowerCase()}@example.com`;
  const response = await api.post('/api/auth/register', {
    email,
    name,
    password: 'correct horse battery',
  });
  if (response.status !== 201) {
    throw new Error(`register failed: ${response.status} ${JSON.stringify(response.body)}`);
  }
  const session = response.cookies.find((cookie) => cookie.name === 'cd_session');
  if (!session) throw new Error('no session cookie');
  api.cookie = session.value;
  const me = await api.get('/api/auth/me');
  return {
    id: response.body.user.id,
    email,
    name,
    api,
    token: session.value,
    personalWorkspaceId: me.body.workspaces[0].id,
  };
}
