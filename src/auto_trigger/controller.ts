/**
 * Antigravity Cockpit - Auto Trigger Controller
 * 自动触发功能的主控制器
 * 整合 OAuth、调度器、触发器，提供统一的接口
 */

import * as vscode from 'vscode';
import { credentialStorage } from './credential_storage';
import { oauthService } from './oauth_service';
import { schedulerService, CronParser } from './scheduler_service';
import { triggerService } from './trigger_service';
import {
    AutoTriggerState,
    ScheduleConfig,
    AutoTriggerMessage,
    SCHEDULE_PRESETS
} from './types';
import { logger } from '../shared/log_service';
import { t } from '../shared/i18n';

// 存储键
const SCHEDULE_CONFIG_KEY = 'scheduleConfig';

/**
 * 自动触发控制器
 */
class AutoTriggerController {
    private initialized = false;
    private messageHandler?: (message: AutoTriggerMessage) => void;
    /** 配额中显示的模型常量列表，用于过滤可用模型 */
    private quotaModelConstants: string[] = [];
    /** 模型 ID 到模型常量的映射 (id -> modelConstant) */
    private modelIdToConstant: Map<string, string> = new Map();
    /** Fallback 定时器列表 (时段外固定时间触发) */
    private fallbackTimers: ReturnType<typeof setTimeout>[] = [];


    /**
     * 设置配额模型常量列表（从 Dashboard 的配额数据中获取）
     */
    setQuotaModels(modelConstants: string[]): void {
        this.quotaModelConstants = modelConstants;
        logger.debug(`[AutoTriggerController] Quota model constants set: ${modelConstants.join(', ')}`);
    }

    /**
     * 初始化控制器
     */
    async initialize(context: vscode.ExtensionContext): Promise<void> {
        if (this.initialized) {
            return;
        }

        // 初始化凭证存储
        credentialStorage.initialize(context);

        // 初始化触发服务（加载历史记录）
        triggerService.initialize();

        // 恢复调度配置
        const savedConfig = credentialStorage.getState<ScheduleConfig | null>(SCHEDULE_CONFIG_KEY, null);
        if (savedConfig) {
            // 互斥逻辑：wakeOnReset 优先，不启动定时调度器
            if (savedConfig.wakeOnReset && savedConfig.enabled) {
                logger.info('[AutoTriggerController] Wake on reset mode enabled, scheduler not started');
                // 如果启用了时段策略且有 fallback 时间，启动 fallback 定时器
                if (savedConfig.timeWindowEnabled && savedConfig.fallbackTimes?.length) {
                    this.startFallbackScheduler(savedConfig);
                }
            } else if (savedConfig.enabled) {
                logger.info('[AutoTriggerController] Restoring schedule from saved config');
                schedulerService.setSchedule(savedConfig, () => this.executeTrigger());
            }
        }

        this.initialized = true;
        logger.info('[AutoTriggerController] Initialized');
    }

    /**
     * 更新状态栏显示（已整合到主配额悬浮提示中，此方法现为空操作）
     */
    private async updateStatusBar(): Promise<void> {
        // 下次触发时间现在显示在主配额悬浮提示中，不再需要单独的状态栏
    }

    /**
     * 获取当前状态
     */
    async getState(): Promise<AutoTriggerState> {
        const authorization = await credentialStorage.getAuthorizationStatus();
        const schedule = credentialStorage.getState<ScheduleConfig>(SCHEDULE_CONFIG_KEY, {
            enabled: false,
            repeatMode: 'daily',
            dailyTimes: ['08:00'],
            selectedModels: ['gemini-3-flash'],
        });

        const nextRunTime = schedulerService.getNextRunTime();
        // 传入配额模型常量进行过滤
        const availableModels = await triggerService.fetchAvailableModels(this.quotaModelConstants);

        // 更新 ID 到常量的映射
        this.modelIdToConstant.clear();
        for (const model of availableModels) {
            if (model.id && model.modelConstant) {
                this.modelIdToConstant.set(model.id, model.modelConstant);
            }
        }
        logger.debug(`[AutoTriggerController] Updated modelIdToConstant mapping: ${this.modelIdToConstant.size} entries`);

        return {
            authorization,
            schedule,
            lastTrigger: triggerService.getLastTrigger(),
            recentTriggers: triggerService.getRecentTriggers(),
            nextTriggerTime: nextRunTime?.toISOString(),
            availableModels,
        };
    }

    /**
     * 开始授权流程
     */
    async startAuthorization(): Promise<boolean> {
        return await oauthService.startAuthorization();
    }

    /**
     * 开始授权流程（别名）
     */
    async authorize(): Promise<boolean> {
        return this.startAuthorization();
    }

    /**
     * 撤销授权
     */
    async revokeAuthorization(): Promise<void> {
        await oauthService.revokeAuthorization();
        // 停止调度器
        schedulerService.stop();
        // 禁用调度
        const schedule = credentialStorage.getState<ScheduleConfig>(SCHEDULE_CONFIG_KEY, {
            enabled: false,
            repeatMode: 'daily',
            selectedModels: ['gemini-3-flash'],
        });
        schedule.enabled = false;
        await credentialStorage.saveState(SCHEDULE_CONFIG_KEY, schedule);
        this.updateStatusBar();
    }

    /**
     * 撤销当前账号授权
     */
    async revokeActiveAccount(): Promise<void> {
        const activeAccount = await credentialStorage.getActiveAccount();
        if (!activeAccount) {
            await this.revokeAuthorization();
            return;
        }
        await this.removeAccount(activeAccount);
    }

    /**
     * 移除指定账号
     * @param email 要移除的账号邮箱
     */
    async removeAccount(email: string): Promise<void> {
        await oauthService.revokeAccount(email);

        // Check if there are remaining accounts
        const hasAuth = await credentialStorage.hasValidCredential();
        if (!hasAuth) {
            // No accounts left, stop scheduler and disable schedule
            schedulerService.stop();
            const schedule = credentialStorage.getState<ScheduleConfig>(SCHEDULE_CONFIG_KEY, {
                enabled: false,
                repeatMode: 'daily',
                selectedModels: ['gemini-3-flash'],
            });
            schedule.enabled = false;
            await credentialStorage.saveState(SCHEDULE_CONFIG_KEY, schedule);
        }

        this.updateStatusBar();
        this.notifyStateUpdate();
    }

    /**
     * 切换活跃账号
     * @param email 要切换到的账号邮箱
     */
    async switchAccount(email: string): Promise<void> {
        await credentialStorage.setActiveAccount(email);
        logger.info(`[AutoTriggerController] Switched to account: ${email}`);
        this.notifyStateUpdate();
    }

    /**
     * 重新授权指定账号（先切换到该账号再重新授权）
     * @param email 要重新授权的账号邮箱
     */
    async reauthorizeAccount(email: string): Promise<void> {
        // 先切换到该账号
        await credentialStorage.setActiveAccount(email);
        logger.info(`[AutoTriggerController] Reauthorizing account: ${email}`);
        
        // 执行重新授权流程
        const success = await oauthService.startAuthorization();
        if (!success) {
            throw new Error('Reauthorization cancelled or failed');
        }
        
        this.notifyStateUpdate();
    }

    /**
     * 保存调度配置
     */
    async saveSchedule(config: ScheduleConfig): Promise<void> {
        // 验证配置
        if (config.crontab) {
            const result = schedulerService.validateCrontab(config.crontab);
            if (!result.valid) {
                throw new Error(`无效的 crontab 表达式: ${result.error}`);
            }
        }

        // 保存配置
        await credentialStorage.saveState(SCHEDULE_CONFIG_KEY, config);

        // 互斥逻辑：三选一
        // 1. wakeOnReset = true → 配额重置触发（不需要定时器）
        // 2. wakeOnReset = false + enabled = true → 定时/Crontab 触发
        // 3. 都为 false → 不触发
        if (config.wakeOnReset) {
            // 配额重置模式：停止定时调度器
            schedulerService.stop();
            this.stopFallbackScheduler();
            logger.info('[AutoTriggerController] Schedule saved, wakeOnReset mode enabled');
            // 如果启用了时段策略且有 fallback 时间，启动 fallback 定时器
            if (config.timeWindowEnabled && config.fallbackTimes?.length) {
                this.startFallbackScheduler(config);
            }
        } else if (config.enabled) {
            // 定时/Crontab 模式
            this.stopFallbackScheduler();
            const accounts = await this.resolveAccountsFromList(config.selectedAccounts);
            if (accounts.length === 0) {
                throw new Error('请先完成授权');
            }
            schedulerService.setSchedule(config, () => this.executeTrigger());
            logger.info(`[AutoTriggerController] Schedule saved, enabled=${config.enabled}`);
        } else {
            // 都不启用
            schedulerService.stop();
            this.stopFallbackScheduler();
            logger.info('[AutoTriggerController] Schedule saved, all triggers disabled');
        }

        this.updateStatusBar();
    }

    /**
     * 解析可用账号列表（多账号）
     */
    private async resolveAccountsFromList(requestedAccounts?: string[]): Promise<string[]> {
        const allCredentials = await credentialStorage.getAllCredentials();
        const allEmails = Object.keys(allCredentials);
        if (allEmails.length === 0) {
            return [];
        }

        const requested = (requestedAccounts || []).filter(email => email in allCredentials);
        const candidates = requested.length > 0 ? requested : [];

        if (candidates.length === 0) {
            const active = await credentialStorage.getActiveAccount();
            if (active && active in allCredentials) {
                candidates.push(active);
            }
        }

        if (candidates.length === 0) {
            candidates.push(allEmails[0]);
        }

        return candidates.filter(email => Boolean(allCredentials[email]?.refreshToken));
    }

    /**
     * 获取调度触发账号列表（多账号）
     */
    private async resolveScheduleAccounts(schedule: ScheduleConfig): Promise<string[]> {
        return this.resolveAccountsFromList(schedule.selectedAccounts);
    }

    /**
     * 手动触发一次
     * @param models 可选的自定义模型列表
     */
    async testTrigger(models?: string[], accounts?: string[]): Promise<void> {
        const targetAccounts = await this.resolveAccountsFromList(accounts);
        if (targetAccounts.length === 0) {
            vscode.window.showErrorMessage('请先完成授权');
            return;
        }

        vscode.window.showInformationMessage('⏳ 正在发送触发请求...');

        // 如果传入了自定义模型列表，使用自定义的；否则使用配置中的
        let selectedModels = models;
        if (!selectedModels || selectedModels.length === 0) {
            const schedule = credentialStorage.getState<ScheduleConfig>(SCHEDULE_CONFIG_KEY, {
                enabled: false,
                repeatMode: 'daily',
                selectedModels: ['gemini-3-flash'],
            });
            selectedModels = schedule.selectedModels || ['gemini-3-flash'];
        }

        let anySuccess = false;
        let totalDuration = 0;
        let firstError: string | undefined;

        for (const email of targetAccounts) {
            const result = await triggerService.trigger(selectedModels, 'manual', undefined, 'manual', email);
            totalDuration += result.duration || 0;
            if (result.success) {
                anySuccess = true;
            } else if (!firstError) {
                firstError = result.message;
            }
        }

        if (anySuccess) {
            vscode.window.showInformationMessage(`✅ 触发成功！耗时 ${totalDuration}ms`);
        } else {
            vscode.window.showErrorMessage(`❌ 触发失败: ${firstError || 'Unknown error'}`);
        }

        // 通知 UI 更新
        this.notifyStateUpdate();
    }

    /**
     * 立即触发（别名，返回结果）
     * @param models 可选的自定义模型列表，如果不传则使用配置中的模型
     * @param customPrompt 可选的自定义唤醒词
     */
    async triggerNow(
        models?: string[],
        customPrompt?: string,
        accounts?: string[],
    ): Promise<{ success: boolean; duration?: number; error?: string; response?: string }> {
        const targetAccounts = await this.resolveAccountsFromList(accounts);
        if (targetAccounts.length === 0) {
            return { success: false, error: '请先完成授权' };
        }

        // 如果传入了自定义模型列表，使用自定义的；否则使用配置中的
        let selectedModels = models;
        if (!selectedModels || selectedModels.length === 0) {
            const schedule = credentialStorage.getState<ScheduleConfig>(SCHEDULE_CONFIG_KEY, {
                enabled: false,
                repeatMode: 'daily',
                selectedModels: ['gemini-3-flash'],
            });
            selectedModels = schedule.selectedModels || ['gemini-3-flash'];
        }

        let anySuccess = false;
        let totalDuration = 0;
        let firstResponse: string | undefined;
        let firstError: string | undefined;

        for (const email of targetAccounts) {
            const result = await triggerService.trigger(selectedModels, 'manual', customPrompt, 'manual', email);
            totalDuration += result.duration || 0;
            if (result.success) {
                anySuccess = true;
                if (!firstResponse) {
                    firstResponse = result.message;
                }
            } else if (!firstError) {
                firstError = result.message;
            }
        }

        // 通知 UI 更新
        this.notifyStateUpdate();

        return {
            success: anySuccess,
            duration: totalDuration || undefined,
            error: anySuccess ? undefined : (firstError || 'Unknown error'),
            response: anySuccess ? firstResponse : undefined,  // AI 回复内容
        };
    }

    /**
     * 清空历史记录
     */
    async clearHistory(): Promise<void> {
        triggerService.clearHistory();
        this.notifyStateUpdate();
    }

    /**
     * 执行触发（由调度器调用）
     */
    private async executeTrigger(): Promise<void> {
        const schedule = credentialStorage.getState<ScheduleConfig>(SCHEDULE_CONFIG_KEY, {
            enabled: false,
            repeatMode: 'daily',
            selectedModels: ['gemini-3-flash'],
        });
        const triggerSource = schedule.crontab ? 'crontab' : 'scheduled';
        const accounts = await this.resolveScheduleAccounts(schedule);
        if (accounts.length === 0) {
            logger.warn('[AutoTriggerController] Scheduled trigger skipped: no valid accounts');
            return;
        }

        for (const email of accounts) {
            const result = await triggerService.trigger(
                schedule.selectedModels,
                'auto',
                schedule.customPrompt,
                triggerSource,
                email,
            );

            if (result.success) {
                logger.info(`[AutoTriggerController] Scheduled trigger executed successfully for ${email}`);
            } else {
                logger.error(`[AutoTriggerController] Scheduled trigger failed for ${email}: ${result.message}`);
            }
        }

        // 通知 UI 更新
        this.notifyStateUpdate();
    }

    /**
     * 检查配额重置并自动触发唤醒
     * 由 ReactorCore 在配额刷新后调用
     * @param models 模型配额信息数组
     */
    async checkAndTriggerOnQuotaReset(models: Array<{ id: string; resetAt?: string; remaining: number; limit: number }>): Promise<void> {
        logger.debug(`[AutoTriggerController] checkAndTriggerOnQuotaReset called, models count: ${models.length}`);

        // 获取调度配置
        const schedule = credentialStorage.getState<ScheduleConfig>(SCHEDULE_CONFIG_KEY, {
            enabled: false,
            repeatMode: 'daily',
            selectedModels: ['gemini-3-flash'],
        });

        logger.debug(`[AutoTriggerController] Schedule config: enabled=${schedule.enabled}, wakeOnReset=${schedule.wakeOnReset}, selectedModels=${JSON.stringify(schedule.selectedModels)}`);

        if (!schedule.enabled) {
            logger.debug('[AutoTriggerController] Wake-up disabled, skipping');
            return;
        }

        // 检查是否启用了"配额重置时自动唤醒"
        if (!schedule.wakeOnReset) {
            logger.debug('[AutoTriggerController] Wake on reset is disabled, skipping');
            return;
        }

        // 检查时段策略
        if (schedule.timeWindowEnabled) {
            const inWindow = this.isInTimeWindow(schedule.timeWindowStart, schedule.timeWindowEnd);
            if (!inWindow) {
                logger.debug('[AutoTriggerController] Outside time window, quota reset trigger skipped (will use fallback times)');
                return;
            }
        }

        const accounts = await this.resolveScheduleAccounts(schedule);
        if (accounts.length === 0) {
            logger.debug('[AutoTriggerController] Wake on reset: Not authorized, skipping');
            return;
        }

        // 检查每个选中的模型是否需要触发
        const selectedModels = schedule.selectedModels || [];
        const modelsToTrigger: string[] = [];

        logger.debug(`[AutoTriggerController] Checking ${selectedModels.length} selected models`);
        logger.debug(`[AutoTriggerController] Available model constants in quota: ${models.map(m => m.id).join(', ')}`);
        logger.debug(`[AutoTriggerController] modelIdToConstant map size: ${this.modelIdToConstant.size}`);

        for (const modelId of selectedModels) {
            // 将用户选择的 ID 转换为 modelConstant
            const modelConstant = this.modelIdToConstant.get(modelId);
            logger.debug(`[AutoTriggerController] Model ${modelId} -> constant: ${modelConstant || 'NOT FOUND'}`);

            if (!modelConstant) {
                logger.debug(`[AutoTriggerController] Model ${modelId} has no constant mapping, trying direct match`);
            }

            // 先用 modelConstant 查找，找不到再用原始 ID
            const modelQuota = models.find(m => m.id === modelConstant) || models.find(m => m.id === modelId);
            if (!modelQuota) {
                logger.debug(`[AutoTriggerController] Model ${modelId} not found in quota data`);
                continue;
            }
            if (!modelQuota.resetAt) {
                logger.debug(`[AutoTriggerController] Model ${modelId} has no resetAt`);
                continue;
            }

            logger.debug(`[AutoTriggerController] Model ${modelId}: remaining=${modelQuota.remaining}, limit=${modelQuota.limit}, resetAt=${modelQuota.resetAt}`);

            // 检查是否应该触发 - 使用 modelConstant 作为 key 来避免重复触发
            const triggerKey = modelConstant || modelId;
            if (triggerService.shouldTriggerOnReset(triggerKey, modelQuota.resetAt, modelQuota.remaining, modelQuota.limit)) {
                logger.debug(`[AutoTriggerController] Model ${modelId} should trigger!`);
                modelsToTrigger.push(modelId);
                // 立即标记已触发，防止重复
                triggerService.markResetTriggered(triggerKey, modelQuota.resetAt);
            } else {
                logger.debug(`[AutoTriggerController] Model ${modelId} should NOT trigger`);
            }
        }

        if (modelsToTrigger.length === 0) {
            logger.debug('[AutoTriggerController] No models to trigger');
            return;
        }

        // 触发唤醒
        logger.info(`[AutoTriggerController] Wake on reset: Triggering for models: ${modelsToTrigger.join(', ')}`);
        for (const email of accounts) {
            const result = await triggerService.trigger(modelsToTrigger, 'auto', schedule.customPrompt, 'quota_reset', email);

            if (result.success) {
                logger.info(`[AutoTriggerController] Wake on reset: Trigger successful for ${email}`);
            } else {
                logger.error(`[AutoTriggerController] Wake on reset: Trigger failed for ${email}: ${result.message}`);
            }
        }

        // 通知 UI 更新
        this.notifyStateUpdate();
    }

    /**
     * 获取调度描述
     */
    describeSchedule(config: ScheduleConfig): string {
        return schedulerService.describeSchedule(config);
    }

    /**
     * 获取预设模板
     */
    getPresets(): typeof SCHEDULE_PRESETS {
        return SCHEDULE_PRESETS;
    }

    /**
     * 将配置转换为 crontab
     */
    configToCrontab(config: ScheduleConfig): string {
        return schedulerService.configToCrontab(config);
    }

    /**
     * 验证 crontab
     */
    validateCrontab(crontab: string): { valid: boolean; description?: string; error?: string } {
        const result = CronParser.parse(crontab);
        return {
            valid: result.valid,
            description: result.description,
            error: result.error,
        };
    }

    /**
     * 获取下次运行时间的格式化字符串
     */
    getNextRunTimeFormatted(): string | null {
        const nextRun = schedulerService.getNextRunTime();
        if (!nextRun) {
            return null;
        }

        const now = new Date();
        const diff = nextRun.getTime() - now.getTime();

        if (diff < 0) {
            return null;
        }

        // 如果是今天，显示时间
        if (nextRun.toDateString() === now.toDateString()) {
            return nextRun.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
        }

        // 如果是明天，显示 "明天 HH:MM"
        const tomorrow = new Date(now);
        tomorrow.setDate(tomorrow.getDate() + 1);
        if (nextRun.toDateString() === tomorrow.toDateString()) {
            return `明天 ${nextRun.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
        }

        // 其他情况显示日期和时间
        return nextRun.toLocaleString(undefined, {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
        });
    }

    /**
     * 处理来自 Webview 的消息
     */
    async handleMessage(message: AutoTriggerMessage): Promise<void> {
        switch (message.type) {
            case 'auto_trigger_get_state':
                this.notifyStateUpdate();
                break;

            case 'auto_trigger_start_auth':
                await this.startAuthorization();
                this.notifyStateUpdate();
                break;

            case 'auto_trigger_revoke_auth':
                await this.revokeAuthorization();
                this.notifyStateUpdate();
                break;

            case 'auto_trigger_save_schedule':
                try {
                    await this.saveSchedule(message.data as unknown as ScheduleConfig);
                    this.notifyStateUpdate();
                } catch (error) {
                    const err = error instanceof Error ? error : new Error(String(error));
                    vscode.window.showErrorMessage(err.message);
                }
                break;

            case 'auto_trigger_test_trigger':
                await this.testTrigger(message.data?.models, message.data?.accounts as string[] | undefined);
                break;

            default:
                logger.warn(`[AutoTriggerController] Unknown message type: ${message.type}`);
        }
    }

    /**
     * 设置消息处理器（用于向 Webview 发送更新）
     */
    setMessageHandler(handler: (message: AutoTriggerMessage) => void): void {
        this.messageHandler = handler;
    }

    /**
     * 通知状态更新
     */
    private async notifyStateUpdate(): Promise<void> {
        // 更新状态栏
        this.updateStatusBar();

        if (this.messageHandler) {
            const state = await this.getState();
            this.messageHandler({
                type: 'auto_trigger_state_update',
                data: state as any,
            });
        }
    }

    /**
     * 判断当前时间是否在指定的时间窗口内
     * @param startTime 开始时间 (如 "09:00")
     * @param endTime 结束时间 (如 "18:00")
     * @returns true 如果在窗口内
     */
    private isInTimeWindow(startTime?: string, endTime?: string): boolean {
        if (!startTime || !endTime) {
            return true; // 未配置时默认在窗口内
        }

        const now = new Date();
        const currentMinutes = now.getHours() * 60 + now.getMinutes();

        const parseTime = (timeStr: string): number => {
            const [h, m] = timeStr.split(':').map(Number);
            return h * 60 + m;
        };

        const startMinutes = parseTime(startTime);
        const endMinutes = parseTime(endTime);

        // 处理跨天情况 (如 22:00 - 06:00)
        if (startMinutes <= endMinutes) {
            // 正常情况: 09:00 - 18:00
            return currentMinutes >= startMinutes && currentMinutes < endMinutes;
        } else {
            // 跨天情况: 22:00 - 06:00
            return currentMinutes >= startMinutes || currentMinutes < endMinutes;
        }
    }

    /**
     * 启动 fallback 定时器（在时段外的固定时间点触发）
     */
    private startFallbackScheduler(config: ScheduleConfig): void {
        this.stopFallbackScheduler();

        const fallbackTimes = config.fallbackTimes || [];
        if (fallbackTimes.length === 0) {
            return;
        }

        logger.info(`[AutoTriggerController] Starting fallback scheduler with times: ${fallbackTimes.join(', ')}`);

        const scheduleNextFallback = () => {
            const now = new Date();
            const currentMinutes = now.getHours() * 60 + now.getMinutes();

            // 找到下一个触发时间点
            const parseTime = (timeStr: string): number => {
                const [h, m] = timeStr.split(':').map(Number);
                return h * 60 + m;
            };

            const times = fallbackTimes.map(t => parseTime(t)).sort((a, b) => a - b);
            let nextTime = times.find(t => t > currentMinutes);

            // 如果今天没有更多时间点，取明天第一个
            const isNextDay = nextTime === undefined;
            if (isNextDay) {
                nextTime = times[0];
            }

            // 如果还是没有时间点，退出
            if (nextTime === undefined) {
                logger.warn('[AutoTriggerController] No fallback times available');
                return;
            }

            // 计算延迟毫秒数
            let delayMinutes = nextTime - currentMinutes;
            if (isNextDay) {
                delayMinutes += 24 * 60;
            }
            const delayMs = delayMinutes * 60 * 1000;

            logger.info(`[AutoTriggerController] Next fallback trigger in ${delayMinutes} minutes (${(nextTime / 60) | 0}:${String(nextTime % 60).padStart(2, '0')})`);

            const timer = setTimeout(async () => {
                // 再次检查是否仍然在时段外
                if (config.timeWindowEnabled) {
                    const inWindow = this.isInTimeWindow(config.timeWindowStart, config.timeWindowEnd);
                    if (inWindow) {
                        logger.info('[AutoTriggerController] Fallback trigger skipped: now inside time window');
                        scheduleNextFallback();
                        return;
                    }
                }

                logger.info('[AutoTriggerController] Fallback trigger firing');
                await this.executeFallbackTrigger(config);
                scheduleNextFallback();
            }, delayMs);

            this.fallbackTimers.push(timer);
        };

        scheduleNextFallback();
    }

    /**
     * 停止所有 fallback 定时器
     */
    private stopFallbackScheduler(): void {
        for (const timer of this.fallbackTimers) {
            clearTimeout(timer);
        }
        this.fallbackTimers = [];
        logger.debug('[AutoTriggerController] Fallback scheduler stopped');
    }

    /**
     * 执行 fallback 触发
     */
    private async executeFallbackTrigger(config: ScheduleConfig): Promise<void> {
        const accounts = await this.resolveAccountsFromList(config.selectedAccounts);
        if (accounts.length === 0) {
            logger.warn('[AutoTriggerController] Fallback trigger skipped: no valid accounts');
            return;
        }

        const selectedModels = config.selectedModels || ['gemini-3-flash'];
        for (const email of accounts) {
            const result = await triggerService.trigger(
                selectedModels,
                'auto',
                config.customPrompt,
                'scheduled', // 标记为 scheduled 类型
                email,
            );

            if (result.success) {
                logger.info(`[AutoTriggerController] Fallback trigger successful for ${email}`);
            } else {
                logger.error(`[AutoTriggerController] Fallback trigger failed for ${email}: ${result.message}`);
            }
        }

        this.notifyStateUpdate();
    }

    /**
     * 销毁控制器
     */
    dispose(): void {
        schedulerService.stop();
        this.stopFallbackScheduler();
        logger.info('[AutoTriggerController] Disposed');
    }
}

// 导出单例
export const autoTriggerController = new AutoTriggerController();
