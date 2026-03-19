export class EcaRemoteApi {
  private baseUrl: string;
  private token: string;

  constructor(host: string, token: string) {
    const protocol = host.startsWith('localhost') || host.startsWith('127.0.0.1')
      ? 'http' : 'https';
    this.baseUrl = `${protocol}://${host}/api/v1`;
    this.token = token;
  }

  private headers(json = false): HeadersInit {
    const h: HeadersInit = { 'Authorization': `Bearer ${this.token}` };
    if (json) h['Content-Type'] = 'application/json';
    return h;
  }

  async health(): Promise<{ status: string; version: string }> {
    const res = await fetch(`${this.baseUrl}/health`);
    if (!res.ok) throw new Error(`Health check failed: ${res.status}`);
    return res.json();
  }

  async session(): Promise<any> {
    const res = await fetch(`${this.baseUrl}/session`, { headers: this.headers() });
    if (!res.ok) throw new Error(`Session fetch failed: ${res.status}`);
    return res.json();
  }

  async chats(): Promise<any[]> {
    const res = await fetch(`${this.baseUrl}/chats`, { headers: this.headers() });
    if (!res.ok) throw new Error(`Chats fetch failed: ${res.status}`);
    return res.json();
  }

  async getChat(chatId: string): Promise<any> {
    const res = await fetch(`${this.baseUrl}/chats/${chatId}`, { headers: this.headers() });
    if (!res.ok) throw new Error(`Get chat failed: ${res.status}`);
    return res.json();
  }

  async sendPrompt(chatId: string, body: {
    message: string;
    model?: string;
    agent?: string;
    variant?: string;
    trust?: boolean;
    contexts?: any[];
  }): Promise<any> {
    const res = await fetch(`${this.baseUrl}/chats/${chatId}/prompt`, {
      method: 'POST',
      headers: this.headers(true),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err?.error?.message || `Prompt failed: ${res.status}`);
    }
    return res.json();
  }

  async stopPrompt(chatId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/chats/${chatId}/stop`, {
      method: 'POST',
      headers: this.headers(),
    });
    if (!res.ok && res.status !== 409) {
      throw new Error(`Stop failed: ${res.status}`);
    }
  }

  async approveToolCall(chatId: string, toolCallId: string, save?: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/chats/${chatId}/approve/${toolCallId}`, {
      method: 'POST',
      headers: this.headers(!!save),
      ...(save ? { body: JSON.stringify({ save }) } : {}),
    });
    if (!res.ok && res.status !== 409) {
      throw new Error(`Approve failed: ${res.status}`);
    }
  }

  async rejectToolCall(chatId: string, toolCallId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/chats/${chatId}/reject/${toolCallId}`, {
      method: 'POST',
      headers: this.headers(),
    });
    if (!res.ok && res.status !== 409) {
      throw new Error(`Reject failed: ${res.status}`);
    }
  }

  async rollbackChat(chatId: string, contentId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/chats/${chatId}/rollback`, {
      method: 'POST',
      headers: this.headers(true),
      body: JSON.stringify({ contentId }),
    });
    if (!res.ok) throw new Error(`Rollback failed: ${res.status}`);
  }

  async clearChat(chatId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/chats/${chatId}/clear`, {
      method: 'POST',
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(`Clear failed: ${res.status}`);
  }

  async deleteChat(chatId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/chats/${chatId}`, {
      method: 'DELETE',
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
  }

  async changeModel(chatId: string, model: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/chats/${chatId}/model`, {
      method: 'POST',
      headers: this.headers(true),
      body: JSON.stringify({ model }),
    });
    if (!res.ok) throw new Error(`Change model failed: ${res.status}`);
  }

  async changeAgent(chatId: string, agent: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/chats/${chatId}/agent`, {
      method: 'POST',
      headers: this.headers(true),
      body: JSON.stringify({ agent }),
    });
    if (!res.ok) throw new Error(`Change agent failed: ${res.status}`);
  }

  async changeVariant(chatId: string, variant: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/chats/${chatId}/variant`, {
      method: 'POST',
      headers: this.headers(true),
      body: JSON.stringify({ variant }),
    });
    if (!res.ok) throw new Error(`Change variant failed: ${res.status}`);
  }

  sseUrl(): string {
    return `${this.baseUrl}/events`;
  }

  get authToken(): string {
    return this.token;
  }
}
