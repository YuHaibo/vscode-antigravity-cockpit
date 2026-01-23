import * as vscode from 'vscode';
import { logger } from '../shared/log_service';
import { credentialStorage } from '../auto_trigger/credential_storage';
import { ReactorCore } from '../engine/reactor';
import { cockpitToolsWs, AccountInfo } from './cockpitToolsWs';
import { syncAccountsWithCockpitTools } from './cockpitToolsSync';
import { configService } from '../shared/config_service';
import { QuotaSnapshot } from '../shared/types';
import { t } from '../shared/i18n';

export interface AccountQuotaCache {
    snapshot: QuotaSnapshot;
    fetchedAt: number;
    loading?: boolean;
    error?: string;
}

export interface AccountState {
    email: string;
    toolsId: string | null;
    isCurrent: boolean;
    hasDeviceBound: boolean;
    hasPluginCredential: boolean;
    tier?: string;
}

export class AccountsRefreshService {
    private accounts: Map<string, AccountState> = new Map();
    private quotaCache: Map<string, AccountQuotaCache> = new Map();
    private currentEmail: string | null = null;
    private initialized = false;
    private initError: string | null = null;
    private toolsAvailable = false;

    private refreshTimer?: ReturnType<typeof setInterval>;
    private lastManualRefresh = 0;
    private static readonly MANUAL_REFRESH_COOLDOWN_MS = 10000;
    private isRefreshingQuotas = false;
    private refreshInFlight: Promise<void> | null = null;

    private readonly onDidUpdateEmitter = new vscode.EventEmitter<void>();
    readonly onDidUpdate = this.onDidUpdateEmitter.event;

    constructor(private readonly reactor: ReactorCore) {
        this.startAutoRefresh();
        void this.refresh();
    }

    dispose(): void {
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
            this.refreshTimer = undefined;
        }
        this.onDidUpdateEmitter.dispose();
    }

    getAccountsMap(): ReadonlyMap<string, AccountState> {
        return this.accounts;
    }

    getQuotaCacheMap(): ReadonlyMap<string, AccountQuotaCache> {
        return this.quotaCache;
    }

    getAccount(email: string): AccountState | undefined {
        return this.accounts.get(email);
    }

    getQuotaCache(email: string): AccountQuotaCache | undefined {
        return this.quotaCache.get(email);
    }

    getCurrentEmail(): string | null {
        return this.currentEmail;
    }

    isInitialized(): boolean {
        return this.initialized;
    }

    getInitError(): string | null {
        return this.initError;
    }

    isToolsAvailable(): boolean {
        return this.toolsAvailable;
    }

    async manualRefresh(): Promise<boolean> {
        const now = Date.now();
        const elapsed = now - this.lastManualRefresh;
        const remaining = AccountsRefreshService.MANUAL_REFRESH_COOLDOWN_MS - elapsed;

        if (remaining > 0) {
            const seconds = Math.ceil(remaining / 1000);
            vscode.window.showWarningMessage(t('accountsRefresh.refreshCooldown', { seconds: seconds.toString() }));
            return false;
        }

        this.lastManualRefresh = now;
        await this.refresh();
        return true;
    }

    async refresh(options?: { forceSync?: boolean; skipSync?: boolean; reason?: string }): Promise<void> {
        if (this.refreshInFlight) {
            return this.refreshInFlight;
        }

        this.refreshInFlight = (async () => {
            this.initError = null;
            this.emitUpdate();

            try {
                const reason = options?.reason ?? 'accountsRefresh.refresh';
                if (!options?.skipSync) {
                    await syncAccountsWithCockpitTools({ reason, force: options?.forceSync });
                }

                if (cockpitToolsWs.isConnected) {
                    await this.loadAccountsFromWebSocket();
                } else {
                    await this.loadAccountsFromSharedFile();
                }

                this.initialized = true;
                logger.info(`[AccountsRefresh] Loaded ${this.accounts.size} accounts, tools available: ${this.toolsAvailable}`);
                this.emitUpdate();

                for (const [email, account] of this.accounts) {
                    if (!account.hasPluginCredential) {
                        this.setMissingCredentialCache(email);
                        continue;
                    }
                    await this.silentLoadAccountQuota(email);
                }
            } catch (err) {
                const error = err instanceof Error ? err.message : String(err);
                this.initError = t('accountsRefresh.loadFailed', { error });
                this.toolsAvailable = false;
                this.initialized = true;
                logger.error('[AccountsRefresh] Failed to load accounts:', error);
                this.emitUpdate();
            }
        })();

        try {
            await this.refreshInFlight;
        } finally {
            this.refreshInFlight = null;
        }
    }

    async refreshQuotas(): Promise<void> {
        if (this.refreshInFlight) {
            await this.refreshInFlight;
            return;
        }

        // 配额刷新不依赖 Cockpit Tools，只需要插件自身的凭证即可

        if (this.isRefreshingQuotas) {
            logger.debug('[AccountsRefresh] Quota refresh already in progress, skipping');
            return;
        }

        this.isRefreshingQuotas = true;
        try {
            for (const [email, account] of this.accounts) {
                if (!account.hasPluginCredential) {
                    this.setMissingCredentialCache(email);
                    continue;
                }
                await this.silentLoadAccountQuota(email);
            }
        } finally {
            this.isRefreshingQuotas = false;
        }
    }

    async loadAccountQuota(email: string): Promise<void> {
        const account = this.accounts.get(email);
        if (account && !account.hasPluginCredential) {
            this.setMissingCredentialCache(email);
            this.emitUpdate();
            return;
        }

        const cache = this.quotaCache.get(email) || {
            snapshot: { timestamp: new Date(), models: [], isConnected: false },
            fetchedAt: 0,
        };
        cache.loading = true;
        cache.error = undefined;
        this.quotaCache.set(email, cache);
        this.emitUpdate();

        try {
            const snapshot = await this.reactor.fetchQuotaForAccount(email);
            cache.snapshot = snapshot;
            cache.fetchedAt = Date.now();
            cache.loading = false;
            cache.error = undefined;
            logger.info(`[AccountsRefresh] Loaded quota for ${email}: ${snapshot.models.length} models, ${snapshot.groups?.length ?? 0} groups`);
        } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            cache.loading = false;
            cache.error = error;
            logger.error(`[AccountsRefresh] Failed to load quota for ${email}:`, error);
        }

        this.quotaCache.set(email, cache);
        this.emitUpdate();
    }

    async getAccountId(email: string): Promise<string | null> {
        const cached = this.accounts.get(email);
        if (cached?.toolsId) {
            return cached.toolsId;
        }

        if (!this.toolsAvailable || !cockpitToolsWs.isConnected) {
            return null;
        }

        try {
            const resp = await cockpitToolsWs.getAccounts();
            const acc = resp.accounts.find((a: AccountInfo) => a.email === email);
            return acc?.id ?? null;
        } catch {
            return null;
        }
    }

    private startAutoRefresh(): void {
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
        }

        const intervalMs = configService.getRefreshIntervalMs();
        logger.info(`[AccountsRefresh] Starting auto refresh, interval: ${intervalMs}ms`);

        this.refreshTimer = setInterval(() => {
            void this.refreshQuotas();
        }, intervalMs);
    }

    private async loadAccountsFromWebSocket(): Promise<void> {
        this.toolsAvailable = true;

        const toolsResp = await cockpitToolsWs.getAccounts();
        const toolsAccounts = toolsResp.accounts ?? [];

        const credentials = await credentialStorage.getAllCredentials();
        const pluginEmails = new Set(Object.keys(credentials));

        this.accounts.clear();

        let currentEmail: string | null = null;

        for (const acc of toolsAccounts) {
            const isCurrent = acc.is_current || (toolsResp.current_account_id ? acc.id === toolsResp.current_account_id : false);
            if (isCurrent) {
                currentEmail = acc.email;
            }

            this.accounts.set(acc.email, {
                email: acc.email,
                toolsId: acc.id ?? null,
                isCurrent,
                hasDeviceBound: acc.has_fingerprint,
                hasPluginCredential: pluginEmails.has(acc.email),
                tier: this.extractTierFromAccount(acc),
            });
        }

        this.currentEmail = currentEmail;
        this.cleanupQuotaCache();
    }

    private async loadAccountsFromSharedFile(): Promise<void> {
        this.toolsAvailable = false;

        const credentials = await credentialStorage.getAllCredentials();
        const pluginEmails = Object.keys(credentials);

        if (pluginEmails.length === 0) {
            this.accounts.clear();
            this.currentEmail = null;
            this.initError = t('accountsRefresh.noAccounts');
            return;
        }

        let currentEmailFromFile: string | null = null;
        try {
            const os = await import('os');
            const path = await import('path');
            const fs = await import('fs');

            const sharedDir = path.join(os.homedir(), '.antigravity_cockpit');
            const currentAccountFile = path.join(sharedDir, 'current_account.json');

            if (fs.existsSync(currentAccountFile)) {
                const content = fs.readFileSync(currentAccountFile, 'utf-8');
                const data = JSON.parse(content) as { email?: string };
                if (data.email && pluginEmails.includes(data.email)) {
                    currentEmailFromFile = data.email;
                }
            }
        } catch {
            // ignore
        }

        this.accounts.clear();
        for (const email of pluginEmails) {
            const isCurrent = email === currentEmailFromFile;
            this.accounts.set(email, {
                email,
                toolsId: null,
                isCurrent,
                hasDeviceBound: false,
                hasPluginCredential: true,
            });
        }

        this.currentEmail = currentEmailFromFile;
        this.cleanupQuotaCache();
    }

    private cleanupQuotaCache(): void {
        const validEmails = new Set(this.accounts.keys());
        for (const email of this.quotaCache.keys()) {
            if (!validEmails.has(email)) {
                this.quotaCache.delete(email);
            }
        }
    }

    private async silentLoadAccountQuota(email: string): Promise<void> {
        const account = this.accounts.get(email);
        if (account && !account.hasPluginCredential) {
            this.setMissingCredentialCache(email);
            return;
        }

        try {
            const snapshot = await this.reactor.fetchQuotaForAccount(email);
            const cache: AccountQuotaCache = {
                snapshot,
                fetchedAt: Date.now(),
                loading: false,
                error: undefined,
            };
            this.quotaCache.set(email, cache);
            this.emitUpdate();
            logger.info(`[AccountsRefresh] Refreshed quota for ${email}: ${snapshot.models.length} models, ${snapshot.groups?.length ?? 0} groups`);
        } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            logger.debug(`[AccountsRefresh] Silent refresh failed for ${email}: ${error}`);
        }
    }

    private setMissingCredentialCache(email: string): void {
        const cache: AccountQuotaCache = {
            snapshot: { timestamp: new Date(), models: [], isConnected: false },
            fetchedAt: Date.now(),
            loading: false,
            error: t('accountsRefresh.notImported'),
        };
        this.quotaCache.set(email, cache);
        this.emitUpdate();
    }

    private extractTierFromAccount(account: { [key: string]: unknown }): string | undefined {
        const tier = account.subscription_tier
            || account.subscriptionTier
            || account.tier;
        return typeof tier === 'string' && tier.trim() ? tier.trim() : undefined;
    }

    private emitUpdate(): void {
        this.onDidUpdateEmitter.fire();
    }
}
