import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createHash } from 'crypto';

export type QuotaCacheSource = 'authorized' | 'local';

export interface QuotaCacheModel {
    id: string;
    displayName?: string;
    remainingPercentage?: number;
    remainingFraction?: number;
    resetTime?: string;
    isRecommended?: boolean;
    tagTitle?: string;
    supportsImages?: boolean;
    supportedMimeTypes?: Record<string, boolean>;
}

export interface QuotaCacheRecord {
    version: 1;
    source: QuotaCacheSource;
    email?: string | null;
    updatedAt: number;
    subscriptionTier?: string | null;
    isForbidden?: boolean;
    models: QuotaCacheModel[];
}

const CACHE_ROOT = path.join(os.homedir(), '.antigravity_cockpit', 'cache', 'quota');

function normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
}

function hashEmail(email: string): string {
    return createHash('sha256').update(normalizeEmail(email)).digest('hex');
}

function getCacheFilePath(source: QuotaCacheSource, email: string): string {
    const filename = `${hashEmail(email)}.json`;
    return path.join(CACHE_ROOT, source, filename);
}

async function ensureCacheDir(source: QuotaCacheSource): Promise<void> {
    const dir = path.join(CACHE_ROOT, source);
    await fs.mkdir(dir, { recursive: true });
}

export async function readQuotaCache(
    source: QuotaCacheSource,
    email: string,
): Promise<QuotaCacheRecord | null> {
    try {
        const filePath = getCacheFilePath(source, email);
        const content = await fs.readFile(filePath, 'utf8');
        const parsed = JSON.parse(content) as QuotaCacheRecord;
        if (!parsed || parsed.version !== 1 || parsed.source !== source) {
            return null;
        }
        return parsed;
    } catch (error) {
        return null;
    }
}

export async function writeQuotaCache(record: QuotaCacheRecord): Promise<void> {
    if (!record.email) {
        return;
    }
    await ensureCacheDir(record.source);
    const filePath = getCacheFilePath(record.source, record.email);
    const tempPath = `${filePath}.tmp`;
    const content = JSON.stringify(record, null, 2);
    await fs.writeFile(tempPath, content, 'utf8');
    await fs.rename(tempPath, filePath);
}
