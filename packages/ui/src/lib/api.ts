import type { ClientApplyResponse, ClientId, ClientStatus, Config, ManualProbeResponse, ProjectConfigEntry, ProjectTakeoverClientId, ProjectsResponse, ProviderHealthResponse, ProviderQuotaResponse, WorkBuddyImportRequest, WorkBuddyKind, WorkBuddyMutationResponse, WorkBuddyStatusResponse, WorkBuddyUsageResponse } from '@/types';

// API Client Class for handling requests with baseUrl and apikey authentication
class ApiClient {
  private baseUrl: string;
  private apiKey: string;
  private tempApiKey: string | null;
  private configWrites = 0;
  private workBuddyManagementBusy = false;

  // Shared with top-level Save: a stale full-config write must not race a
  // managed import/disconnect, including the subsequent config reconciliation.
  acquireWorkBuddyManagement(): (() => void) | null {
    if (this.workBuddyManagementBusy || this.configWrites > 0) return null;
    this.workBuddyManagementBusy = true;
    return () => { this.workBuddyManagementBusy = false; };
  }

  constructor(baseUrl: string = '/api', apiKey: string = '') {
    this.baseUrl = baseUrl;
    // Load API key from localStorage if available
    this.apiKey = apiKey || localStorage.getItem('apiKey') || '';
    // Load temp API key from URL if available
    this.tempApiKey = new URLSearchParams(window.location.search).get('tempApiKey');
  }

  // Update base URL
  setBaseUrl(url: string) {
    this.baseUrl = url;
  }

  // Update API key
  setApiKey(apiKey: string) {
    this.apiKey = apiKey;
    // Save API key to localStorage
    if (apiKey) {
      localStorage.setItem('apiKey', apiKey);
    } else {
      localStorage.removeItem('apiKey');
    }
  }

  // Update temp API key
  setTempApiKey(tempApiKey: string | null) {
    this.tempApiKey = tempApiKey;
  }

  // Create headers with API key authentication
  private createHeaders(contentType: string = 'application/json'): HeadersInit {
    const headers: Record<string, string> = {
      'Accept': 'application/json',
    };

    // Use temp API key if available, otherwise use regular API key
    if (this.tempApiKey) {
      headers['X-Temp-API-Key'] = this.tempApiKey;
    } else if (this.apiKey) {
      headers['X-API-Key'] = this.apiKey;
    }

    if (contentType) {
      headers['Content-Type'] = contentType;
    }

    return headers;
  }

  // Generic fetch wrapper with base URL and authentication.
  // An optional `timeoutMs` on `options` aborts the request after that many
  // milliseconds so a hung server can't leave the caller pending forever.
  private async apiFetch<T>(endpoint: string, options: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    const isWorkBuddy = endpoint.startsWith('/workbuddy/');
    const { timeoutMs, ...rest } = options;

    const config: RequestInit = {
      ...rest,
      headers: {
        ...this.createHeaders(),
        ...rest.headers,
      },
    };

    if (timeoutMs && config.signal === undefined) {
      config.signal = AbortSignal.timeout(timeoutMs);
    }

    try {
      const response = await fetch(url, config);

      // Handle 401 Unauthorized responses
      if (response.status === 401) {
        // Remove API key when it's invalid
        localStorage.removeItem('apiKey');
        // Redirect to login page if not already there
        // For memory router, we need to use the router instance
        // We'll dispatch a custom event that the app can listen to
        window.dispatchEvent(new CustomEvent('unauthorized'));
        // Return a promise that never resolves to prevent further execution
        if (isWorkBuddy) throw new Error('workbuddy_unauthorized');
        return new Promise(() => {}) as Promise<T>;
      }

      if (!response.ok && isWorkBuddy) {
        // Retain only known codes. Raw server/upstream messages must never enter
        // the browser's error object, console, toast or component state.
        const allowed = ['sealed', 'source_missing', 'source_invalid', 'models_fetch_failed',
          'workbuddy_name_conflict', 'workbuddy_site_conflict', 'workbuddy_not_connected'];
        let code = 'request_failed';
        try {
          const data = await response.json();
          const candidate = data.reason || data.error;
          if (allowed.includes(candidate)) code = candidate;
        } catch { /* use the safe default */ }
        throw Object.assign(new Error('WorkBuddy request failed'), { reason: code });
      }

      if (!response.ok) {
        // Try to get detailed error message from response body
        let errorMessage = `API request failed: ${response.status} ${response.statusText}`;
        try {
          const errorData = await response.json();
          if (errorData.error || errorData.message) {
            errorMessage = errorData.message || errorData.error || errorMessage;
          }
        } catch {
          // If parsing fails, use default error message
        }
        throw new Error(errorMessage);
      }

      if (response.status === 204) {
        return {} as T;
      }

      const text = await response.text();
      return text ? JSON.parse(text) : ({} as T);

    } catch (error) {
      if (isWorkBuddy) {
        // Network / JSON exceptions can include unsafe text too.
        const reason = error && typeof error === 'object' && 'reason' in error
          ? error.reason : 'request_failed';
        throw Object.assign(new Error('WorkBuddy request failed'), { reason });
      }
      console.error('API request error:', error);
      throw error;
    }
  }

  // GET request
  async get<T>(endpoint: string, timeoutMs?: number): Promise<T> {
    return this.apiFetch<T>(endpoint, {
      method: 'GET',
      timeoutMs,
    });
  }

  // POST request
  async post<T>(endpoint: string, data: unknown, timeoutMs?: number): Promise<T> {
    return this.apiFetch<T>(endpoint, {
      method: 'POST',
      body: JSON.stringify(data),
      timeoutMs,
    });
  }

  // PUT request
  async put<T>(endpoint: string, data: unknown): Promise<T> {
    return this.apiFetch<T>(endpoint, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  // PATCH request
  async patch<T>(endpoint: string, data: unknown): Promise<T> {
    return this.apiFetch<T>(endpoint, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  }

  // DELETE request
  async delete<T>(endpoint: string, body?: any): Promise<T> {
    return this.apiFetch<T>(endpoint, {
      method: 'DELETE',
      body: JSON.stringify(body || {}),
    });
  }

  // API methods for configuration
  // Get current configuration
  async getConfig(): Promise<Config> {
    return this.get<Config>('/config');
  }

  // Update entire configuration
  async updateConfig(config: Config): Promise<{ success: boolean; message?: string }> {
    if (this.workBuddyManagementBusy) return { success: false };
    this.configWrites += 1;
    try {
      return await this.post<{ success: boolean; message?: string }>('/config', config);
    } finally {
      this.configWrites -= 1;
    }
  }

  // Restart service
  async restartService(): Promise<unknown> {
    return this.post<void>('/restart', {});
  }

  // Check for updates
  async checkForUpdates(): Promise<{ hasUpdate: boolean; latestVersion?: string; changelog?: string }> {
    return this.get<{ hasUpdate: boolean; latestVersion?: string; changelog?: string }>('/update/check');
  }

  // Perform update. The npm global install can take minutes, so cap the
  // request at 5 min to match the backend exec timeout and avoid an
  // indefinite hang in the UI.
  async performUpdate(): Promise<{ success: boolean; restarting?: boolean; message: string }> {
    return this.post<{ success: boolean; restarting?: boolean; message: string }>('/update/perform', {}, 300_000);
  }

  // Get log files list
  async getLogFiles(): Promise<Array<{ name: string; path: string; size: number; lastModified: string }>> {
    return this.get<Array<{ name: string; path: string; size: number; lastModified: string }>>('/logs/files');
  }

  // Get logs from specific file
  async getLogs(filePath: string): Promise<string[]> {
    return this.get<string[]>(`/logs?file=${encodeURIComponent(filePath)}`);
  }

  // Clear logs from specific file
  async clearLogs(filePath: string): Promise<void> {
    return this.delete<void>(`/logs?file=${encodeURIComponent(filePath)}`);
  }

  // Get debug log status
  async getDebugLogStatus(): Promise<{ enabled: boolean }> {
    return this.get<{ enabled: boolean }>('/debug-log');
  }

  // Toggle debug log
  async setDebugLogStatus(enabled: boolean): Promise<{ enabled: boolean }> {
    return this.put<{ enabled: boolean }>('/debug-log', { enabled });
  }

  // ========== Client Integrations API methods ==========

  async getClients(): Promise<{ clients: ClientStatus[] }> {
    return this.get<{ clients: ClientStatus[] }>('/clients');
  }

  async applyClients(enabled: ClientId[]): Promise<ClientApplyResponse> {
    return this.post<ClientApplyResponse>('/clients/apply', { enabled });
  }

  async enableClient(id: ClientId): Promise<ClientApplyResponse> {
    return this.post<ClientApplyResponse>(`/clients/${encodeURIComponent(id)}/enable`, {});
  }

  async disableClient(id: ClientId): Promise<ClientApplyResponse> {
    return this.post<ClientApplyResponse>(`/clients/${encodeURIComponent(id)}/disable`, {});
  }

  async restoreClient(id: ClientId): Promise<ClientApplyResponse> {
    return this.post<ClientApplyResponse>(`/clients/${encodeURIComponent(id)}/restore`, {});
  }

  // ========== Project-Level Configuration API methods ==========

  async getProjects(): Promise<ProjectsResponse> {
    return this.get<ProjectsResponse>('/projects');
  }

  async addProject(path: string): Promise<ProjectConfigEntry> {
    return this.post<ProjectConfigEntry>('/projects', { path });
  }

  async updateProject(id: string, Router: Record<string, any>): Promise<ProjectConfigEntry> {
    return this.put<ProjectConfigEntry>(`/projects/${encodeURIComponent(id)}`, { Router });
  }

  async deleteProject(id: string): Promise<{ success: boolean }> {
    return this.delete<{ success: boolean }>(`/projects/${encodeURIComponent(id)}`);
  }

  async setProjectTakeover(id: string, clients: ProjectTakeoverClientId[]): Promise<{ id: string; path: string; ccrTakeover: boolean; ccrTakeoverClients: ProjectTakeoverClientId[] }> {
    return this.put<{ id: string; path: string; ccrTakeover: boolean; ccrTakeoverClients: ProjectTakeoverClientId[] }>(`/projects/${encodeURIComponent(id)}/takeover`, { clients });
  }

  // ========== Usage Statistics API methods ==========

  // Get usage records with summary
  async getUsage(params?: {
    startDate?: string; endDate?: string; model?: string;
    provider?: string; scenario?: string; clientType?: string; sessionId?: string;
    status?: "success" | "error";
    page?: number; pageSize?: number;
  }): Promise<{ records: any[]; summary: any; total: number; page: number; pageSize: number }> {
    const query = new URLSearchParams();
    if (params) {
      Object.entries(params).forEach(([k, v]) => { if (v != null) query.set(k, String(v)); });
    }
    const qs = query.toString();
    return this.get(`/usage${qs ? '?' + qs : ''}`);
  }

  // Get usage summary only
  async getUsageSummary(params?: { startDate?: string; endDate?: string; status?: "success" | "error" }): Promise<any> {
    const query = new URLSearchParams();
    if (params) {
      Object.entries(params).forEach(([k, v]) => { if (v != null) query.set(k, String(v)); });
    }
    const qs = query.toString();
    return this.get(`/usage/summary${qs ? '?' + qs : ''}`);
  }

  // Clear usage data
  async clearUsage(beforeDate?: string): Promise<{ success: boolean; message: string }> {
    const qs = beforeDate ? `?beforeDate=${encodeURIComponent(beforeDate)}` : '';
    return this.delete(`/usage${qs}`);
  }

  // ========== Preset API methods ==========

  // Get presets list
  async getPresets(): Promise<{ presets: Array<any> }> {
    return this.get<{ presets: Array<any> }>('/presets');
  }

  // Get preset details
  async getPreset(name: string): Promise<any> {
    return this.get<any>(`/presets/${encodeURIComponent(name)}`);
  }

  // Install preset from URL
  async installPresetFromUrl(url: string, name?: string): Promise<any> {
    return this.post<any>('/presets/install', { url, name });
  }

  // Upload preset file
  async uploadPresetFile(file: File, name?: string): Promise<any> {
    const formData = new FormData();
    formData.append('file', file);
    if (name) {
      formData.append('name', name);
    }

    const url = `${this.baseUrl}/presets/upload`;

    const headers: Record<string, string> = {
      'Accept': 'application/json',
    };

    // Use temp API key if available, otherwise use regular API key
    if (this.tempApiKey) {
      headers['X-Temp-API-Key'] = this.tempApiKey;
    } else if (this.apiKey) {
      headers['X-API-Key'] = this.apiKey;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: formData,
    });

    if (response.status === 401) {
      localStorage.removeItem('apiKey');
      window.dispatchEvent(new CustomEvent('unauthorized'));
      return new Promise(() => {}) as any;
    }

    if (!response.ok) {
      throw new Error(`Failed to upload preset: ${response.status} ${response.statusText}`);
    }

    return response.json();
  }

  // Apply preset (configure sensitive fields)
  async applyPreset(name: string, secrets: Record<string, string>): Promise<any> {
    return this.post<any>(`/presets/${encodeURIComponent(name)}/apply`, { secrets });
  }

  // Delete preset
  async deletePreset(name: string): Promise<any> {
    return this.delete<any>(`/presets/${encodeURIComponent(name)}`, {});
  }

  // Get market presets
  async getMarketPresets(): Promise<{ presets: Array<any> }> {
    return this.get<{ presets: Array<any> }>('/presets/market');
  }

  // Install preset from GitHub repository
  async installPresetFromGitHub(repo: string, name?: string): Promise<any> {
    return this.post<any>('/presets/install/github', { repo, name });
  }

  // ========== Provider Health API methods ==========

  // Local UI timeout for management reads. These endpoints serve cached data,
  // so the cap only guards against a hung server; it is NOT the slow-network
  // signal (that comes from the server-side probe telemetry).
  private static readonly MANAGEMENT_READ_TIMEOUT_MS = 10_000;

  // Get provider health status (circuit-breaker states + probe telemetry)
  async getProviderHealth(): Promise<ProviderHealthResponse> {
    return this.get<ProviderHealthResponse>(
      '/providers/health',
      ApiClient.MANAGEMENT_READ_TIMEOUT_MS,
    );
  }

  // Get provider quota usage (5h and 7d windows)
  async getProviderQuota(): Promise<ProviderQuotaResponse> {
    return this.get<ProviderQuotaResponse>(
      '/providers/quota',
      ApiClient.MANAGEMENT_READ_TIMEOUT_MS,
    );
  }

  // ========== WorkBuddy built-in provider API methods ==========

  // Management reads are local (no upstream call): the status endpoint only
  // reports the saved provider + credential file summary. It must never read
  // the WorkBuddy desktop login file — only an explicit import does that once.
  getWorkBuddyStatus(): Promise<WorkBuddyStatusResponse> {
    return this.get<WorkBuddyStatusResponse>(
      '/workbuddy/status',
      ApiClient.MANAGEMENT_READ_TIMEOUT_MS,
    );
  }

  // Explicit user action: read the fixed local login file of the explicitly
  // selected site once (the selector makes the international site work even
  // when both desktop files exist), register the managed provider and run
  // model discovery. Never auto-invoked. Later near-expiry inference may do
  // one bounded same-site/same-account desktop re-read in memory. CCR never
  // stores a credential-refresh secret or calls a credential-refresh API.
  // Generous timeout: this performs an upstream config fetch.
  importWorkBuddy(site: WorkBuddyKind): Promise<WorkBuddyMutationResponse> {
    const body: WorkBuddyImportRequest = { site };
    return this.post<WorkBuddyMutationResponse>('/workbuddy/import', body, 60_000);
  }

  syncWorkBuddyModels(): Promise<WorkBuddyMutationResponse> {
    return this.post<WorkBuddyMutationResponse>('/workbuddy/sync', {}, 60_000);
  }

  disconnectWorkBuddy(): Promise<WorkBuddyMutationResponse> {
    return this.post<WorkBuddyMutationResponse>('/workbuddy/disconnect', {}, 30_000);
  }

  // Explicit user action only: read subscription credits once. Never polled
  // automatically. Failures are non-critical and quietly hide the display in
  // the component — no raw quota errors are surfaced.
  getWorkBuddyUsage(): Promise<WorkBuddyUsageResponse> {
    return this.get<WorkBuddyUsageResponse>(
      '/workbuddy/usage',
      ApiClient.MANAGEMENT_READ_TIMEOUT_MS,
    );
  }

  async probeProvider(providerName: string): Promise<ManualProbeResponse> {
    return this.post<ManualProbeResponse>('/providers/probe', { providerName });
  }

  async probeAllProviders(): Promise<{
    results: Array<Omit<ManualProbeResponse, 'timestamp'>>;
    successCount: number;
    total: number;
    timestamp: string;
  }> {
    return this.post<{
      results: Array<Omit<ManualProbeResponse, 'timestamp'>>;
      successCount: number;
      total: number;
      timestamp: string;
    }>('/providers/probe-all', {});
  }
}

// Create a default instance of the API client
export const api = new ApiClient();

// Export the class for creating custom instances
export default ApiClient;
