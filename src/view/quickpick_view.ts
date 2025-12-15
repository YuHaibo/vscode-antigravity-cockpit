/**
 * Antigravity Cockpit - QuickPick 视图
 * 使用 VSCode 原生 QuickPick API 显示配额信息
 * 用于 Webview 不可用的环境（如 ArchLinux + VSCode OSS）
 */

import * as vscode from 'vscode';
import { QuotaSnapshot, ModelQuotaInfo } from '../shared/types';
import { configService } from '../shared/config_service';
import { logger } from '../shared/log_service';
import { t } from '../shared/i18n';
import { DISPLAY_MODE } from '../shared/constants';

/** QuickPick 项扩展接口 */
interface QuotaQuickPickItem extends vscode.QuickPickItem {
    /** 模型 ID（用于置顶操作） */
    modelId?: string;
    /** 操作类型 */
    action?: 'refresh' | 'logs' | 'settings' | 'switchToWebview';
}

/**
 * QuickPick 视图管理器
 */
export class QuickPickView {
    private lastSnapshot?: QuotaSnapshot;
    private refreshCallback?: () => void;

    constructor() {
        logger.debug('QuickPickView initialized');
    }

    /**
     * 设置刷新回调
     */
    onRefresh(callback: () => void): void {
        this.refreshCallback = callback;
    }

    /**
     * 更新数据快照
     */
    updateSnapshot(snapshot: QuotaSnapshot): void {
        this.lastSnapshot = snapshot;
    }

    /**
     * 显示 QuickPick 菜单
     */
    async show(): Promise<void> {
        if (!this.lastSnapshot) {
            vscode.window.showWarningMessage(t('dashboard.connecting'));
            return;
        }

        const pick = vscode.window.createQuickPick<QuotaQuickPickItem>();
        pick.title = t('dashboard.title');
        pick.placeholder = t('quickpick.placeholder');
        pick.matchOnDescription = false;
        pick.matchOnDetail = false;
        pick.canSelectMany = false;

        pick.items = this.buildMenuItems();

        // 跟踪当前选中项
        let currentActiveItem: QuotaQuickPickItem | undefined;

        pick.onDidChangeActive(items => {
            currentActiveItem = items[0] as QuotaQuickPickItem;
        });

        pick.onDidAccept(async () => {
            if (!currentActiveItem) return;

            // 处理操作项
            if (currentActiveItem.action) {
                pick.hide();
                await this.handleAction(currentActiveItem.action);
                return;
            }

            // 处理模型置顶切换
            if (currentActiveItem.modelId) {
                await configService.togglePinnedModel(currentActiveItem.modelId);
                // 刷新菜单
                pick.items = this.buildMenuItems();
            }
        });

        pick.onDidHide(() => {
            pick.dispose();
        });

        pick.show();
    }

    /**
     * 构建菜单项
     */
    private buildMenuItems(): QuotaQuickPickItem[] {
        const items: QuotaQuickPickItem[] = [];
        const snapshot = this.lastSnapshot;
        const config = configService.getConfig();

        // 用户信息（如果有）
        if (snapshot?.userInfo) {
            items.push({
                label: `$(account) ${snapshot.userInfo.name}`,
                description: snapshot.userInfo.planName,
                kind: vscode.QuickPickItemKind.Separator,
            });
        }

        // 配额模型列表
        items.push({
            label: t('quickpick.quotaSection'),
            kind: vscode.QuickPickItemKind.Separator,
        });

        if (snapshot && snapshot.models.length > 0) {
            const pinnedModels = config.pinnedModels;

            for (const model of snapshot.models) {
                const pct = model.remainingPercentage ?? 0;
                const bar = this.drawProgressBar(pct);
                const isPinned = pinnedModels.some(
                    p => p.toLowerCase() === model.modelId.toLowerCase(),
                );

                // 状态图标
                const statusIcon = model.isExhausted 
                    ? '$(error)' 
                    : pct < config.criticalThreshold 
                        ? '$(error)' 
                        : pct < config.warningThreshold 
                            ? '$(warning)' 
                            : '$(check)';

                // 置顶标识
                const pinIcon = isPinned ? '$(pinned)' : '$(circle-outline)';

                items.push({
                    label: `${pinIcon} ${statusIcon} ${model.label}`,
                    description: `${bar} ${pct.toFixed(1)}%`,
                    detail: `    ${t('dashboard.resetIn')}: ${model.timeUntilResetFormatted}`,
                    modelId: model.modelId,
                });
            }
        } else {
            items.push({
                label: `$(info) ${t('quickpick.noData')}`,
                description: t('dashboard.connecting'),
            });
        }

        // 操作按钮
        items.push({
            label: t('quickpick.actionsSection'),
            kind: vscode.QuickPickItemKind.Separator,
        });

        items.push({
            label: `$(sync) ${t('dashboard.refresh')}`,
            description: '',
            action: 'refresh',
        });

        items.push({
            label: `$(output) ${t('help.openLogs')}`,
            description: '',
            action: 'logs',
        });

        items.push({
            label: `$(gear) ${t('quickpick.openSettings')}`,
            description: '',
            action: 'settings',
        });

        items.push({
            label: `$(browser) ${t('quickpick.switchToWebview')}`,
            description: '',
            action: 'switchToWebview',
        });

        return items;
    }

    /**
     * 绘制进度条
     */
    private drawProgressBar(percentage: number): string {
        const total = 10;
        const filled = Math.round((percentage / 100) * total);
        const empty = total - filled;
        return '▓'.repeat(filled) + '░'.repeat(empty);
    }

    /**
     * 处理操作
     */
    private async handleAction(action: 'refresh' | 'logs' | 'settings' | 'switchToWebview'): Promise<void> {
        switch (action) {
            case 'refresh':
                if (this.refreshCallback) {
                    this.refreshCallback();
                }
                break;
            case 'logs':
                vscode.commands.executeCommand('agCockpit.showLogs');
                break;
            case 'settings':
                vscode.commands.executeCommand('workbench.action.openSettings', 'agCockpit');
                break;
            case 'switchToWebview':
                await configService.updateConfig('displayMode', DISPLAY_MODE.WEBVIEW);
                vscode.window.showInformationMessage(t('quickpick.switchedToWebview'));
                // 重新打开 Dashboard（这次会用 Webview）
                vscode.commands.executeCommand('agCockpit.open');
                break;
        }
    }
}
