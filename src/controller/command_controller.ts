
import * as vscode from 'vscode';
import { CockpitHUD } from '../view/hud';
import { QuickPickView } from '../view/quickpick_view';
import { ReactorCore } from '../engine/reactor';
import { configService } from '../shared/config_service';
import { logger } from '../shared/log_service';
import { t } from '../shared/i18n';
import { DISPLAY_MODE, FEEDBACK_URL } from '../shared/constants';
import { announcementService } from '../announcement';

export class CommandController {
    constructor(
        private context: vscode.ExtensionContext,
        private hud: CockpitHUD,
        private quickPickView: QuickPickView,
        private reactor: ReactorCore,
        private onRetry: () => Promise<void>,
    ) {
        this.registerCommands();
    }

    private registerCommands(): void {
        // 打开 Dashboard
        this.context.subscriptions.push(
            vscode.commands.registerCommand('agCockpit.open', async (options?: { tab?: string }) => {
                const config = configService.getConfig();
                if (config.displayMode === DISPLAY_MODE.QUICKPICK) {
                    this.quickPickView.show();
                } else {
                    const success = await this.hud.revealHud(options?.tab ?? 'quota');
                    if (!success) {
                        // Webview 创建失败，引导用户切换到 QuickPick 模式
                        const selection = await vscode.window.showWarningMessage(
                            t('webview.failedPrompt'),
                            t('webview.switchToQuickPick'),
                            t('webview.cancel'),
                        );
                        if (selection === t('webview.switchToQuickPick')) {
                            await configService.updateConfig('displayMode', DISPLAY_MODE.QUICKPICK);
                            vscode.window.showInformationMessage(t('webview.switchedToQuickPick'));
                            this.reactor.reprocess();
                            this.quickPickView.show();
                        }
                    }
                }
            }),
        );

        // 手动刷新
        this.context.subscriptions.push(
            vscode.commands.registerCommand('agCockpit.refresh', () => {
                this.reactor.syncTelemetry();
                vscode.window.showInformationMessage(t('notify.refreshing'));
            }),
        );

        // 显示日志
        this.context.subscriptions.push(
            vscode.commands.registerCommand('agCockpit.showLogs', () => {
                logger.show();
            }),
        );

        // 重试连接
        this.context.subscriptions.push(
            vscode.commands.registerCommand('agCockpit.retry', async () => {
                await this.onRetry();
            }),
        );

        // 打开反馈页面
        this.context.subscriptions.push(
            vscode.commands.registerCommand('agCockpit.openFeedback', () => {
                vscode.env.openExternal(vscode.Uri.parse(FEEDBACK_URL));
            }),
        );

        // 设置警告阈值
        this.context.subscriptions.push(
            vscode.commands.registerCommand('agCockpit.setWarningThreshold', async () => {
                const config = configService.getConfig();
                const input = await vscode.window.showInputBox({
                    prompt: t('threshold.setWarning', { value: config.warningThreshold }),
                    placeHolder: t('threshold.inputWarning'),
                    value: String(config.warningThreshold),
                    validateInput: (value) => {
                        const num = parseInt(value, 10);
                        if (isNaN(num) || num < 5 || num > 80) {
                            return t('threshold.invalid', { min: 5, max: 80 });
                        }
                        if (num <= config.criticalThreshold) {
                            return `Warning threshold must be greater than critical threshold (${config.criticalThreshold}%)`;
                        }
                        return null;
                    },
                });
                if (input) {
                    const newValue = parseInt(input, 10);
                    await configService.updateConfig('warningThreshold', newValue);
                    vscode.window.showInformationMessage(t('threshold.updated', { value: newValue }));
                    this.reactor.reprocess();
                }
            }),
        );

        // 设置危险阈值
        this.context.subscriptions.push(
            vscode.commands.registerCommand('agCockpit.setCriticalThreshold', async () => {
                const config = configService.getConfig();
                const input = await vscode.window.showInputBox({
                    prompt: t('threshold.setCritical', { value: config.criticalThreshold }),
                    placeHolder: t('threshold.inputCritical'),
                    value: String(config.criticalThreshold),
                    validateInput: (value) => {
                        const num = parseInt(value, 10);
                        if (isNaN(num) || num < 1 || num > 50) {
                            return t('threshold.invalid', { min: 1, max: 50 });
                        }
                        if (num >= config.warningThreshold) {
                            return `Critical threshold must be less than warning threshold (${config.warningThreshold}%)`;
                        }
                        return null;
                    },
                });
                if (input) {
                    const newValue = parseInt(input, 10);
                    await configService.updateConfig('criticalThreshold', newValue);
                    vscode.window.showInformationMessage(t('threshold.updated', { value: newValue }));
                    this.reactor.reprocess();
                }
            }),
        );

        // 强制刷新公告
        this.context.subscriptions.push(
            vscode.commands.registerCommand('agCockpit.refreshAnnouncements', async () => {
                try {
                    const state = await announcementService.forceRefresh();
                    vscode.window.showInformationMessage(
                        t('announcement.refreshed').replace('{count}', String(state.announcements.length)),
                    );
                    // 更新 HUD 中的公告状态
                    this.hud.sendMessage({
                        type: 'announcementState',
                        data: state,
                    });
                } catch (error) {
                    const err = error instanceof Error ? error : new Error(String(error));
                    vscode.window.showErrorMessage(`Failed to refresh announcements: ${err.message}`);
                }
            }),
        );

        // [调试命令] 仅在开发模式下可用
        if (this.context.extensionMode === vscode.ExtensionMode.Development) {
            this.registerDebugCommands();
        }
    }

    /**
     * 注册调试命令（仅开发模式）
     */
    private registerDebugCommands(): void {
        // 重置扩展状态到初始安装状态
        this.context.subscriptions.push(
            vscode.commands.registerCommand('agCockpit.resetExtensionState', async () => {
                const confirm = await vscode.window.showWarningMessage(
                    '🔧 [DEBUG] This will reset ALL extension data:\n' +
                    '• Clear all globalState (groupings, pins, preferences)\n' +
                    '• Clear authorization credentials\n' +
                    '• Reset quotaSource to "local"\n\n' +
                    'Restart VS Code after this to simulate first-time install.',
                    { modal: true },
                    'Reset All',
                    'Cancel',
                );

                if (confirm !== 'Reset All') {
                    return;
                }

                try {
                    // 1. 清除所有已知的 globalState 键
                    const stateKeys = [
                        // config_service 的状态键 (state.xxx)
                        'state.migratedToGlobalState',
                        'state.pinnedModels',
                        'state.modelOrder',
                        'state.customGroupMappings',
                        'state.customGroupNames',
                        'state.modelCustomNames',
                        'state.visibleModels',
                        // auto_trigger 的状态键
                        'antigravity.autoTrigger.state.triggerHistory',
                        'antigravity.autoTrigger.state.lastResetTriggerTimestamps',
                        'antigravity.autoTrigger.state.lastResetTriggerAt',
                        'antigravity.autoTrigger.state.isEnabled',
                        'antigravity.autoTrigger.state.scheduleRules',
                        'antigravity.autoTrigger.state.selectedModels',
                        'antigravity.autoTrigger.state.customPrompt',
                        // announcement 的状态键
                        'announcement_cache',
                        'announcement_read_ids',
                    ];

                    for (const key of stateKeys) {
                        await this.context.globalState.update(key, undefined);
                    }
                    logger.info('[Debug] Cleared all globalState keys');

                    // 2. 清除授权凭证 (通过 credentialStorage)
                    const { credentialStorage } = await import('../auto_trigger');
                    await credentialStorage.deleteCredential();
                    logger.info('[Debug] Cleared authorization credentials');

                    // 3. 重置 quotaSource 配置到默认值 local
                    await configService.updateConfig('quotaSource', 'local');
                    logger.info('[Debug] Reset quotaSource to local');

                    vscode.window.showInformationMessage(
                        '✅ Extension state has been reset!\n\n' +
                        'Please restart VS Code (Cmd+Shift+P > "Developer: Reload Window") ' +
                        'to simulate a first-time install.',
                    );
                } catch (error) {
                    const err = error instanceof Error ? error : new Error(String(error));
                    logger.error(`[Debug] Failed to reset extension state: ${err.message}`);
                    vscode.window.showErrorMessage(`Failed to reset: ${err.message}`);
                }
            }),
        );

        logger.info('[Debug] Debug commands registered (Development mode)');
    }
}
