
import * as vscode from 'vscode';
import { CockpitHUD } from '../view/hud';
import { ReactorCore } from '../engine/reactor';
import { configService } from '../shared/config_service';
import { logger } from '../shared/log_service';
import { t, i18n } from '../shared/i18n';
import { WebviewMessage } from '../shared/types';
import { TIMING } from '../shared/constants';
import { autoTriggerController } from '../auto_trigger/controller';
import { credentialStorage } from '../auto_trigger';
import { announcementService } from '../announcement';

export class MessageController {
    // 跟踪已通知的模型以避免重复弹窗 (虽然主要逻辑在 TelemetryController，但 CheckAndNotify 可能被消息触发吗? 不, 主要是 handleMessage)
    // 这里主要是处理前端发来的指令
    private context: vscode.ExtensionContext;

    constructor(
        context: vscode.ExtensionContext,
        private hud: CockpitHUD,
        private reactor: ReactorCore,
        private onRetry: () => Promise<void>,
    ) {
        this.context = context;
        this.setupMessageHandling();
    }

    private async applyQuotaSourceChange(
        source: 'local' | 'authorized',
    ): Promise<void> {
        const previousSource = configService.getConfig().quotaSource;

        if (source === 'authorized') {
            this.reactor.cancelInitRetry();
        }

        logger.info(`User changed quota source to: ${source}`);
        await configService.updateConfig('quotaSource', source);

        // 发送 loading 状态提示
        this.hud.sendMessage({
            type: 'quotaSourceLoading',
            data: { source },
        });
        this.hud.sendMessage({
            type: 'switchTab',
            tab: 'quota',
        });

        // 如果配额来源发生变化，触发完整初始化流程
        if (previousSource !== source) {
            if (source === 'local') {
                await this.onRetry();
            } else {
                this.reactor.syncTelemetry();
            }
            return;
        }

        const cacheAge = this.reactor.getCacheAgeMs(source);
        const refreshIntervalMs = configService.getConfig().refreshInterval ?? TIMING.DEFAULT_REFRESH_INTERVAL_MS;
        const hasCache = this.reactor.publishCachedTelemetry(source);
        const cacheStale = cacheAge === undefined || cacheAge > refreshIntervalMs;
        if (!hasCache || cacheStale) {
            this.reactor.syncTelemetry();
        }
    }

    private setupMessageHandling(): void {
        // 设置 autoTriggerController 的消息处理器，使其能够推送状态更新到 webview
        autoTriggerController.setMessageHandler((message) => {
            if (message.type === 'auto_trigger_state_update') {
                this.hud.sendMessage({
                    type: 'autoTriggerState',
                    data: message.data,
                });
            }
        });

        this.hud.onSignal(async (message: WebviewMessage) => {
            switch (message.command) {
                case 'togglePin':
                    logger.info(`Received togglePin signal: ${JSON.stringify(message)}`);
                    if (message.modelId) {
                        await configService.togglePinnedModel(message.modelId);
                        this.reactor.reprocess();
                    } else {
                        logger.warn('togglePin signal missing modelId');
                    }
                    break;

                case 'toggleCredits':
                    logger.info('User toggled Prompt Credits display');
                    await configService.toggleShowPromptCredits();
                    this.reactor.reprocess();
                    break;

                case 'updateOrder':
                    if (message.order) {
                        logger.info(`User updated model order. Count: ${message.order.length}`);
                        await configService.updateModelOrder(message.order);
                        this.reactor.reprocess();
                    } else {
                        logger.warn('updateOrder signal missing order data');
                    }
                    break;

                case 'updateVisibleModels':
                    if (Array.isArray(message.visibleModels)) {
                        logger.info(`User updated visible models. Count: ${message.visibleModels.length}`);
                        await configService.updateVisibleModels(message.visibleModels);
                        if (configService.getConfig().quotaSource === 'authorized') {
                            await configService.setStateFlag('visibleModelsInitializedAuthorized', true);
                        }
                        this.reactor.reprocess();
                    } else {
                        logger.warn('updateVisibleModels signal missing visibleModels');
                    }
                    break;

                case 'resetOrder': {
                    const currentConfig = configService.getConfig();
                    if (currentConfig.groupingEnabled) {
                        logger.info('User reset group order to default');
                        await configService.resetGroupOrder();
                    } else {
                        logger.info('User reset model order to default');
                        await configService.resetModelOrder();
                    }
                    this.reactor.reprocess();
                    break;
                }

                case 'refresh':
                    logger.info('User triggered manual refresh');
                    this.reactor.syncTelemetry();
                    break;

                case 'init':
                    if (this.reactor.hasCache) {
                        logger.info('Dashboard initialized (reprocessing cached data)');
                        this.reactor.reprocess();
                    } else {
                        logger.info('Dashboard initialized (no cache, performing full sync)');
                        this.reactor.syncTelemetry();
                    }
                    // 发送公告状态
                    {
                        const annState = await announcementService.getState();
                        this.hud.sendMessage({
                            type: 'announcementState',
                            data: annState,
                        });
                    }

                    break;

                case 'retry':
                    logger.info('User triggered connection retry');
                    await this.onRetry();
                    break;

                case 'openLogs':
                    logger.info('User opened logs');
                    logger.show();
                    break;

                case 'rerender':
                    logger.info('Dashboard requested re-render');
                    this.reactor.reprocess();
                    break;

                case 'toggleGrouping': {
                    logger.info('User toggled grouping display');
                    const enabled = await configService.toggleGroupingEnabled();
                    // 用户期望：切换到分组模式时，状态栏默认也显示分组
                    if (enabled) {
                        const config = configService.getConfig();
                        if (!config.groupingShowInStatusBar) {
                            await configService.updateConfig('groupingShowInStatusBar', true);
                        }

                        // 首次开启分组时（groupMappings 为空），自动执行分组
                        if (Object.keys(config.groupMappings).length === 0) {
                            const latestSnapshot = this.reactor.getLatestSnapshot();
                            if (latestSnapshot && latestSnapshot.models.length > 0) {
                                const newMappings = ReactorCore.calculateGroupMappings(latestSnapshot.models);
                                await configService.updateGroupMappings(newMappings);
                                logger.info(`First-time grouping: auto-grouped ${Object.keys(newMappings).length} models`);
                            }
                        }
                    }
                    // 使用缓存数据重新渲染
                    this.reactor.reprocess();
                    break;
                }

                case 'renameGroup':
                    if (message.modelIds && message.groupName) {
                        logger.info(`User renamed group to: ${message.groupName}`);
                        await configService.updateGroupName(message.modelIds, message.groupName);
                        // 使用缓存数据重新渲染
                        this.reactor.reprocess();
                    } else {
                        logger.warn('renameGroup signal missing required data');
                    }
                    break;

                case 'promptRenameGroup':
                    if (message.modelIds && message.currentName) {
                        const newName = await vscode.window.showInputBox({
                            prompt: t('grouping.renamePrompt'),
                            value: message.currentName,
                            placeHolder: t('grouping.rename'),
                        });
                        if (newName && newName.trim() && newName !== message.currentName) {
                            logger.info(`User renamed group to: ${newName}`);
                            await configService.updateGroupName(message.modelIds, newName.trim());
                            this.reactor.reprocess();
                        }
                    } else {
                        logger.warn('promptRenameGroup signal missing required data');
                    }
                    break;

                case 'toggleGroupPin':
                    if (message.groupId) {
                        logger.info(`Toggling group pin: ${message.groupId}`);
                        await configService.togglePinnedGroup(message.groupId);
                        this.reactor.reprocess();
                    } else {
                        logger.warn('toggleGroupPin signal missing groupId');
                    }
                    break;

                case 'updateGroupOrder':
                    if (message.order) {
                        logger.info(`User updated group order. Count: ${message.order.length}`);
                        await configService.updateGroupOrder(message.order);
                        this.reactor.reprocess();
                    } else {
                        logger.warn('updateGroupOrder signal missing order data');
                    }
                    break;

                case 'autoGroup': {
                    logger.info('User triggered auto-grouping');
                    // 获取最新的快照数据
                    const latestSnapshot = this.reactor.getLatestSnapshot();
                    if (latestSnapshot && latestSnapshot.models.length > 0) {
                        // 计算新的分组映射
                        const newMappings = ReactorCore.calculateGroupMappings(latestSnapshot.models);
                        await configService.updateGroupMappings(newMappings);
                        logger.info(`Auto-grouped ${Object.keys(newMappings).length} models`);

                        // 清除之前的 pinnedGroups（因为 groupId 已变化）
                        await configService.updateConfig('pinnedGroups', []);

                        // 重新处理数据以刷新 UI
                        this.reactor.reprocess();
                    } else {
                        logger.warn('No snapshot data available for auto-grouping');
                    }
                    break;
                }

                case 'updateNotificationEnabled':
                    // 处理通知开关变更
                    if (message.notificationEnabled !== undefined) {
                        const enabled = message.notificationEnabled as boolean;
                        await configService.updateConfig('notificationEnabled', enabled);
                        logger.info(`Notification enabled: ${enabled}`);
                        vscode.window.showInformationMessage(
                            enabled ? t('notification.enabled') : t('notification.disabled'),
                        );
                    }
                    break;

                case 'updateThresholds':
                    // 处理阈值更新
                    if (message.warningThreshold !== undefined && message.criticalThreshold !== undefined) {
                        const warningVal = message.warningThreshold as number;
                        const criticalVal = message.criticalThreshold as number;

                        if (criticalVal < warningVal && warningVal >= 5 && warningVal <= 80 && criticalVal >= 1 && criticalVal <= 50) {
                            await configService.updateConfig('warningThreshold', warningVal);
                            await configService.updateConfig('criticalThreshold', criticalVal);
                            logger.info(`Thresholds updated: warning=${warningVal}%, critical=${criticalVal}%`);
                            vscode.window.showInformationMessage(
                                t('threshold.updated', { value: `Warning: ${warningVal}%, Critical: ${criticalVal}%` }),
                            );
                            // 注意：notifiedModels 清理逻辑通常在 TelemetryController，这里可能无法直接访问
                            // 我们可以让 reactor 重新发送数据，如果 TelemetryController 监听了 configChange 或数据变化，会自动处理？
                            // 最好是这里只更新配置，reprocess 会触发 reactor 的逻辑。
                            // 但 notifiedModels 是内存状态。
                            // 临时方案：不清理，或者通过 reactor 发送一个事件？
                            // 观察 extension.ts，'notifiedModels.clear()' 是直接调用的。
                            // 我们可以将 notifiedModels 移入 TelemetryController 并提供一个 reset 方法。
                            // 这里先保留注释。
                            this.reactor.reprocess();
                        } else {
                            logger.warn('Invalid threshold values received from dashboard');
                        }
                    }
                    break;

                case 'renameModel':
                    if (message.modelId && message.groupName !== undefined) {
                        logger.info(`User renamed model ${message.modelId} to: ${message.groupName}`);
                        await configService.updateModelName(message.modelId, message.groupName);
                        // 使用缓存数据重新渲染
                        this.reactor.reprocess();
                    } else {
                        logger.warn('renameModel signal missing required data');
                    }
                    break;

                case 'updateStatusBarFormat':
                    if (message.statusBarFormat) {
                        logger.info(`User changed status bar format to: ${message.statusBarFormat}`);
                        await configService.updateConfig('statusBarFormat', message.statusBarFormat);
                        // 立即刷新状态栏
                        this.reactor.reprocess();
                    } else {
                        logger.warn('updateStatusBarFormat signal missing statusBarFormat');
                    }
                    break;

                case 'toggleProfile':
                    // 切换计划详情显示/隐藏
                    logger.info('User toggled profile visibility');
                    {
                        const currentConfig = configService.getConfig();
                        await configService.updateConfig('profileHidden', !currentConfig.profileHidden);
                        this.reactor.reprocess();
                    }
                    break;

                case 'updateDisplayMode':
                    if (message.displayMode) {
                        logger.info(`User changed display mode to: ${message.displayMode}`);
                        await configService.updateConfig('displayMode', message.displayMode);

                        if (message.displayMode === 'quickpick') {
                            // 1. 关闭 Webview
                            this.hud.dispose();
                            // 2. 刷新状态栏
                            this.reactor.reprocess();
                            // 3. 立即弹出 QuickPick (通过命令)
                            vscode.commands.executeCommand('agCockpit.open');
                        } else {
                            this.reactor.reprocess();
                        }
                    }
                    break;

                case 'updateQuotaSource':
                    if (message.quotaSource) {
                        await this.applyQuotaSourceChange(message.quotaSource);
                    } else {
                        logger.warn('updateQuotaSource signal missing quotaSource');
                    }
                    break;



                case 'updateDataMasked':
                    // 更新数据遮罩状态
                    if (message.dataMasked !== undefined) {
                        logger.info(`User changed data masking to: ${message.dataMasked}`);
                        await configService.updateConfig('dataMasked', message.dataMasked);
                        this.reactor.reprocess();
                    }
                    break;

                case 'updateLanguage':
                    // 更新语言设置
                    if (message.language !== undefined) {
                        const newLanguage = String(message.language);
                        logger.info(`User changed language to: ${newLanguage}`);
                        await configService.updateConfig('language', newLanguage);
                        // 应用新语言设置
                        i18n.applyLanguageSetting(newLanguage);
                        // 关闭当前面板并重新打开
                        this.hud.dispose();
                        // 短暂延迟后重新打开面板，确保旧面板完全关闭
                        setTimeout(() => {
                            vscode.commands.executeCommand('agCockpit.open');
                        }, 100);
                    }
                    break;

                case 'saveCustomGrouping': {
                    // 保存自定义分组
                    const { customGroupMappings, customGroupNames } = message;
                    if (customGroupMappings) {
                        logger.info(`User saved custom grouping: ${Object.keys(customGroupMappings).length} models`);
                        await configService.updateGroupMappings(customGroupMappings);

                        // 清除之前的 pinnedGroups（因为 groupId 可能已变化）
                        await configService.updateConfig('pinnedGroups', []);

                        // 保存分组名称（如果有）
                        if (customGroupNames) {
                            await configService.updateConfig('groupingCustomNames', customGroupNames);
                        }

                        // 刷新 UI
                        this.reactor.reprocess();
                    }
                    break;
                }

                // ============ Auto Trigger ============
                case 'tabChanged':
                    // Tab 切换时，如果切到自动触发 Tab，发送状态更新
                    if (message.tab === 'auto-trigger') {
                        logger.debug('Switched to Auto Trigger tab');
                        const state = await autoTriggerController.getState();
                        this.hud.sendMessage({
                            type: 'autoTriggerState',
                            data: state,
                        });
                    }
                    break;

                case 'autoTrigger.authorize':
                    logger.info('User triggered OAuth authorization');
                    try {
                        await autoTriggerController.authorize();
                        const state = await autoTriggerController.getState();
                        this.hud.sendMessage({
                            type: 'autoTriggerState',
                            data: state,
                        });
                        if (configService.getConfig().quotaSource === 'authorized') {
                            this.reactor.syncTelemetry();
                        }
                    } catch (error) {
                        const err = error instanceof Error ? error : new Error(String(error));
                        logger.error(`Authorization failed: ${err.message}`);
                        vscode.window.showErrorMessage(`Authorization failed: ${err.message}`);
                    }
                    break;

                case 'autoTrigger.revoke':
                    logger.info('User revoked OAuth authorization');
                    await autoTriggerController.revokeAuthorization();
                    {
                        const state = await autoTriggerController.getState();
                        this.hud.sendMessage({
                            type: 'autoTriggerState',
                            data: state,
                        });
                    }
                    if (configService.getConfig().quotaSource === 'authorized') {
                        this.reactor.syncTelemetry();
                    }
                    break;

                case 'autoTrigger.saveSchedule':
                    if (message.schedule) {
                        logger.info('User saved auto trigger schedule');
                        await autoTriggerController.saveSchedule(message.schedule);
                        const state = await autoTriggerController.getState();
                        this.hud.sendMessage({
                            type: 'autoTriggerState',
                            data: state,
                        });
                        vscode.window.showInformationMessage(t('autoTrigger.saved'));
                    }
                    break;

                case 'autoTrigger.test':
                    logger.info('User triggered manual test');
                    try {
                        // 从消息中获取自定义模型列表
                        const rawModels = (message as { models?: unknown }).models;
                        const testModels = Array.isArray(rawModels)
                            ? rawModels.filter((model): model is string => typeof model === 'string' && model.length > 0)
                            : undefined;
                        // 获取自定义唤醒词
                        const customPrompt = (message as { customPrompt?: string }).customPrompt;
                        const result = await autoTriggerController.triggerNow(testModels, customPrompt);
                        const state = await autoTriggerController.getState();
                        this.hud.sendMessage({
                            type: 'autoTriggerState',
                            data: state,
                        });
                        if (result.success) {
                            // 显示成功消息和 AI 回复
                            const successMsg = t('autoTrigger.triggerSuccess').replace('{duration}', String(result.duration));
                            const responsePreview = result.response
                                ? `\n${result.response.substring(0, 200)}${result.response.length > 200 ? '...' : ''}`
                                : '';
                            vscode.window.showInformationMessage(successMsg + responsePreview);
                        } else {
                            vscode.window.showErrorMessage(
                                t('autoTrigger.triggerFailed').replace('{message}', result.error || 'Unknown error'),
                            );
                        }
                    } catch (error) {
                        const err = error instanceof Error ? error : new Error(String(error));
                        vscode.window.showErrorMessage(
                            t('autoTrigger.triggerFailed').replace('{message}', err.message),
                        );
                    }
                    break;

                case 'autoTrigger.validateCrontab':
                    if (message.crontab) {
                        const result = autoTriggerController.validateCrontab(message.crontab);
                        this.hud.sendMessage({
                            type: 'crontabValidation',
                            data: result,
                        });
                    }
                    break;

                case 'autoTrigger.clearHistory':
                    logger.info('User cleared trigger history');
                    await autoTriggerController.clearHistory();
                    const state = await autoTriggerController.getState();
                    this.hud.sendMessage({
                        type: 'autoTriggerState',
                        data: state,
                    });
                    vscode.window.showInformationMessage(t('autoTrigger.historyCleared'));
                    break;

                case 'autoTrigger.getState':
                    {
                        const state = await autoTriggerController.getState();
                        this.hud.sendMessage({
                            type: 'autoTriggerState',
                            data: state,
                        });
                    }
                    break;

                case 'autoTrigger.addAccount':
                    // Same as authorize - adds a new account
                    logger.info('User adding new account');
                    try {
                        await autoTriggerController.authorize();
                        const state = await autoTriggerController.getState();
                        this.hud.sendMessage({
                            type: 'autoTriggerState',
                            data: state,
                        });
                        if (configService.getConfig().quotaSource === 'authorized') {
                            this.reactor.syncTelemetry();
                        }
                    } catch (error) {
                        const err = error instanceof Error ? error : new Error(String(error));
                        logger.error(`Add account failed: ${err.message}`);
                        vscode.window.showErrorMessage(`Add account failed: ${err.message}`);
                    }
                    break;

                case 'autoTrigger.removeAccount':
                    if (message.email) {
                        logger.info(`User removing account: ${message.email}`);
                        await autoTriggerController.removeAccount(message.email);
                        const state = await autoTriggerController.getState();
                        this.hud.sendMessage({
                            type: 'autoTriggerState',
                            data: state,
                        });
                        if (configService.getConfig().quotaSource === 'authorized') {
                            this.reactor.syncTelemetry();
                        }
                    } else {
                        logger.warn('removeAccount missing email');
                    }
                    break;

                case 'autoTrigger.switchAccount':
                    if (message.email) {
                        logger.info(`User switching to account: ${message.email}`);
                        await autoTriggerController.switchAccount(message.email);
                        const state = await autoTriggerController.getState();
                        this.hud.sendMessage({
                            type: 'autoTriggerState',
                            data: state,
                        });
                        if (configService.getConfig().quotaSource === 'authorized') {
                            this.reactor.syncTelemetry();
                        }
                    } else {
                        logger.warn('switchAccount missing email');
                    }
                    break;


                // ============ Announcements ============
                case 'announcement.getState':
                    {
                        const state = await announcementService.getState();
                        this.hud.sendMessage({
                            type: 'announcementState',
                            data: state,
                        });
                    }
                    break;

                case 'announcement.markAsRead':
                    if (message.id) {
                        await announcementService.markAsRead(message.id);
                        logger.debug(`Marked announcement as read: ${message.id}`);
                        // 更新前端状态
                        const state = await announcementService.getState();
                        this.hud.sendMessage({
                            type: 'announcementState',
                            data: state,
                        });
                    }
                    break;

                case 'announcement.markAllAsRead':
                    await announcementService.markAllAsRead();
                    logger.debug('Marked all announcements as read');
                    {
                        const state = await announcementService.getState();
                        this.hud.sendMessage({
                            type: 'announcementState',
                            data: state,
                        });
                    }
                    break;

                case 'openUrl':
                    if (message.url) {
                        vscode.env.openExternal(vscode.Uri.parse(message.url));
                    }
                    break;

                case 'executeCommand':
                    if (message.commandId) {
                        const args = message.commandArgs;
                        if (args && Array.isArray(args) && args.length > 0) {
                            await vscode.commands.executeCommand(message.commandId, ...args);
                        } else {
                            await vscode.commands.executeCommand(message.commandId);
                        }
                    }
                    break;

            }
        });
    }
}
