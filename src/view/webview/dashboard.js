/**
 * Antigravity Cockpit - Dashboard 脚本
 * 处理 Webview 交互逻辑
 */

(function() {
    'use strict';

    // 获取 VS Code API
    const vscode = acquireVsCodeApi();

    // DOM 元素
    const dashboard = document.getElementById('dashboard');
    const statusDiv = document.getElementById('status');
    const refreshBtn = document.getElementById('refresh-btn');
    const resetOrderBtn = document.getElementById('reset-order-btn');
    const toast = document.getElementById('toast');

    // 国际化文本
    const i18n = window.__i18n || {};

    // 状态
    let isRefreshing = false;
    let dragSrcEl = null;

    // ============ 初始化 ============

    function init() {
        // 恢复状态
        const state = vscode.getState() || {};
        if (state.lastRefresh) {
            const now = Date.now();
            const diff = Math.floor((now - state.lastRefresh) / 1000);
            if (diff < 60) {
                startCooldown(60 - diff);
            }
        }

        // 绑定事件
        // 绑定事件
        refreshBtn.addEventListener('click', handleRefresh);
        if (resetOrderBtn) {
            resetOrderBtn.addEventListener('click', handleResetOrder);
        }

        // 事件委托：处理置顶开关
        dashboard.addEventListener('change', (e) => {
            if (e.target.classList.contains('pin-toggle')) {
                const modelId = e.target.getAttribute('data-model-id');
                if (modelId) {
                    togglePin(modelId);
                }
            }
        });

        // 监听消息
        window.addEventListener('message', handleMessage);

        // 通知扩展已准备就绪
        vscode.postMessage({ command: 'init' });
    }

    // ============ 事件处理 ============

    function handleRefresh() {
        if (refreshBtn.disabled) return;

        isRefreshing = true;
        updateRefreshButton();
        showToast(i18n['notify.refreshing'] || 'Refreshing quota data...', 'info');

        vscode.postMessage({ command: 'refresh' });

        const now = Date.now();
        vscode.setState({ ...vscode.getState(), lastRefresh: now });
        startCooldown(60);
    }



    function handleResetOrder() {
        vscode.postMessage({ command: 'resetOrder' });
        showToast(i18n['dashboard.resetOrder'] || 'Reset Order', 'success');
    }

    function handleMessage(event) {
        const message = event.data;
        
        if (message.type === 'telemetry_update') {
            isRefreshing = false;
            updateRefreshButton();
            render(message.data, message.config);
        }
    }

    // ============ 刷新按钮逻辑 ============

    function updateRefreshButton() {
        if (isRefreshing) {
            refreshBtn.innerHTML = `<span class="spinner"></span>${i18n['dashboard.refreshing'] || 'Refreshing...'}`;
        }
    }

    function startCooldown(seconds) {
        refreshBtn.disabled = true;
        refreshBtn.innerHTML = seconds + 's';

        let remaining = seconds;
        const timer = setInterval(() => {
            remaining--;
            if (remaining <= 0) {
                clearInterval(timer);
                refreshBtn.disabled = false;
                refreshBtn.innerHTML = i18n['dashboard.refresh'] || 'REFRESH';
            } else {
                refreshBtn.innerHTML = remaining + 's';
            }
        }, 1000);
    }

    // ============ Toast 通知 ============

    function showToast(message, type = 'info') {
        if (!toast) return;

        toast.textContent = message;
        toast.className = `toast ${type}`;
        
        // 3秒后隐藏
        setTimeout(() => {
            toast.classList.add('hidden');
        }, 3000);
    }

    // ============ 工具函数 ============

    function getHealthColor(percentage) {
        if (percentage > 50) return 'var(--success)';
        if (percentage > 20) return 'var(--warning)';
        return 'var(--danger)';
    }

    function togglePin(modelId) {
        vscode.postMessage({ command: 'togglePin', modelId: modelId });
    }

    function retryConnection() {
        vscode.postMessage({ command: 'retry' });
    }

    function openLogs() {
        vscode.postMessage({ command: 'openLogs' });
    }

    // 暴露给全局

    window.retryConnection = retryConnection;
    window.openLogs = openLogs;

    // ============ 拖拽排序 ============

    function handleDragStart(e) {
        this.style.opacity = '0.4';
        dragSrcEl = this;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', this.getAttribute('data-id'));
        this.classList.add('dragging');
    }

    function handleDragOver(e) {
        if (e.preventDefault) {
            e.preventDefault();
        }
        e.dataTransfer.dropEffect = 'move';
        return false;
    }

    function handleDragEnter() {
        this.classList.add('over');
    }

    function handleDragLeave() {
        this.classList.remove('over');
    }

    function handleDrop(e) {
        if (e.stopPropagation) {
            e.stopPropagation();
        }

        if (dragSrcEl !== this) {
            const cards = Array.from(dashboard.querySelectorAll('.card'));
            const srcIndex = cards.indexOf(dragSrcEl);
            const targetIndex = cards.indexOf(this);

            if (srcIndex < targetIndex) {
                this.after(dragSrcEl);
            } else {
                this.before(dragSrcEl);
            }

            // 保存新顺序
            const newOrder = Array.from(dashboard.querySelectorAll('.card'))
                .map(card => card.getAttribute('data-id'));
            vscode.postMessage({ command: 'updateOrder', order: newOrder });
        }

        return false;
    }

    function handleDragEnd() {
        this.style.opacity = '1';
        this.classList.remove('dragging');

        document.querySelectorAll('.card').forEach(item => {
            item.classList.remove('over');
        });
    }

    // ============ 渲染 ============

    function render(snapshot, config) {
        statusDiv.style.display = 'none';
        dashboard.innerHTML = '';

        // 检查离线状态
        if (!snapshot.isConnected) {
            renderOfflineCard(snapshot.errorMessage);
            return;
        }

        // Render User Profile (if available) - New Section
        if (snapshot.userInfo) {
            renderUserProfile(snapshot.userInfo);
        }

        // 模型排序
        let models = [...snapshot.models];
        if (config?.modelOrder?.length > 0) {
            const orderMap = new Map();
            config.modelOrder.forEach((id, index) => orderMap.set(id, index));

            models.sort((a, b) => {
                const idxA = orderMap.has(a.modelId) ? orderMap.get(a.modelId) : 99999;
                const idxB = orderMap.has(b.modelId) ? orderMap.get(b.modelId) : 99999;
                return idxA - idxB;
            });
        }



        // 渲染模型卡片
        models.forEach(model => {
            renderModelCard(model, config?.pinnedModels || []);
        });
    }

    function renderOfflineCard(errorMessage) {
        const card = document.createElement('div');
        card.className = 'offline-card';
        card.innerHTML = `
            <div class="icon">🚀</div>
            <h2>${i18n['dashboard.offline'] || 'Systems Offline'}</h2>
            <p>${errorMessage || i18n['dashboard.offlineDesc'] || 'Could not detect Antigravity process. Please ensure Antigravity is running.'}</p>
            <div class="offline-actions">
                <button class="btn-primary" onclick="retryConnection()">
                    ${i18n['help.retry'] || 'Retry Connection'}
                </button>
                <button class="btn-secondary" onclick="openLogs()">
                    ${i18n['help.openLogs'] || 'Open Logs'}
                </button>
            </div>
        `;
        dashboard.appendChild(card);
    }

    // State for profile toggle
    let isProfileExpanded = false;

    function renderUserProfile(userInfo) {
        const card = document.createElement('div');
        card.className = 'card full-width profile-card';

        // Helper for features
        const getFeatureStatus = (enabled) => enabled 
            ? `<span class="tag success">${i18n['feature.enabled'] || 'Enabled'}</span>`
            : `<span class="tag disabled">${i18n['feature.disabled'] || 'Disabled'}</span>`;

        // Build Upgrade Info HTML if available
        let upgradeHtml = '';
        if (userInfo.upgradeText && userInfo.upgradeUri) {
            upgradeHtml = `
            <div class="upgrade-info">
                <div class="upgrade-text">${userInfo.upgradeText}</div>
                <a href="${userInfo.upgradeUri}" class="upgrade-link" target="_blank">Upgrade Now</a>
            </div>`;
        }

        // Toggle visibility style based on state
        const detailsClass = isProfileExpanded ? 'profile-details' : 'profile-details hidden';
        const toggleText = isProfileExpanded ? (i18n['profile.less'] || 'Show Less') : (i18n['profile.more'] || 'Show More Details');
        const iconTransform = isProfileExpanded ? 'rotate(180deg)' : 'rotate(0deg)';


        card.innerHTML = `
            <div class="card-title">
                <span class="label">${i18n['profile.details'] || 'User Profile'}</span>
                <div class="tier-badge">${userInfo.tier}</div>
            </div>
            
            <div class="profile-grid">
                ${createDetailItem(i18n['profile.email'] || 'Email', userInfo.email)}
                ${createDetailItem(i18n['profile.description'] || 'Description', userInfo.tierDescription)}
                ${createDetailItem(i18n['feature.webSearch'] || 'Web Search', getFeatureStatus(userInfo.cascadeWebSearchEnabled))}
                ${createDetailItem(i18n['feature.browser'] || 'Browser Access', getFeatureStatus(userInfo.browserEnabled))}
                ${createDetailItem(i18n['feature.knowledgeBase'] || 'Knowledge Base', getFeatureStatus(userInfo.knowledgeBaseEnabled))}
                ${createDetailItem(i18n['feature.mcp'] || 'MCP Servers', getFeatureStatus(userInfo.allowMcpServers))}
                ${createDetailItem(i18n['feature.gitCommit'] || 'Git Commit', getFeatureStatus(userInfo.canGenerateCommitMessages))}
            </div>

            <div class="${detailsClass}" id="profile-more">
                <div class="profile-grid">
                    ${createDetailItem(i18n['feature.fastMode'] || 'Fast Mode', getFeatureStatus(userInfo.hasAutocompleteFastMode))}
                    ${createDetailItem(i18n['feature.moreCredits'] || 'Can Buy Credits', getFeatureStatus(userInfo.canBuyMoreCredits))}
                    ${createDetailItem(i18n['feature.context'] || 'Context Window', userInfo.maxNumChatInputTokens)}
                    
                    ${createDetailItem('Teams Tier', userInfo.teamsTier)}
                    ${createDetailItem('User ID', userInfo.userTierId || 'N/A')}
                    ${createDetailItem('Tab To Jump', getFeatureStatus(userInfo.hasTabToJump))}
                    ${createDetailItem('Sticky Models', getFeatureStatus(userInfo.allowStickyPremiumModels))}
                    ${createDetailItem('Command Models', getFeatureStatus(userInfo.allowPremiumCommandModels))}
                    ${createDetailItem('Max Premium msgs', userInfo.maxNumPremiumChatMessages)}
                    ${createDetailItem('Chat Instructions Char Limit', userInfo.maxCustomChatInstructionCharacters)}
                    ${createDetailItem('Pinned Context Items', userInfo.maxNumPinnedContextItems)}
                    ${createDetailItem('Local Index Size', userInfo.maxLocalIndexSize)}
                    ${createDetailItem('Accepted TOS', getFeatureStatus(userInfo.acceptedLatestTermsOfService))}
                    ${createDetailItem('Customize Icon', getFeatureStatus(userInfo.canCustomizeAppIcon))}
                    ${createDetailItem('Cascade Auto Run', getFeatureStatus(userInfo.cascadeCanAutoRunCommands))}
                    ${createDetailItem('Cascade Background', getFeatureStatus(userInfo.canAllowCascadeInBackground))}
                    ${createDetailItem('Auto Run Commands', getFeatureStatus(userInfo.allowAutoRunCommands))}
                    ${createDetailItem('Exp. Browser Features', getFeatureStatus(userInfo.allowBrowserExperimentalFeatures))}
                </div>
                ${upgradeHtml}
            </div>

            <div class="profile-toggle">
                <button class="btn-text" id="profile-toggle-btn">
                    <span id="profile-toggle-text">${toggleText}</span> 
                    <span id="profile-toggle-icon" style="transform: ${iconTransform}">▼</span>
                </button>
            </div>
        `;
        dashboard.appendChild(card);
        
        // Bind event listener after element creation
        const toggleBtn = card.querySelector('#profile-toggle-btn');
        if (toggleBtn) {
            toggleBtn.addEventListener('click', toggleProfileDetails);
        }
    }

    // Toggle detailed profile info
    function toggleProfileDetails() {
        const details = document.getElementById('profile-more');
        const text = document.getElementById('profile-toggle-text');
        const icon = document.getElementById('profile-toggle-icon');
        
        if (details.classList.contains('hidden')) {
            details.classList.remove('hidden');
            text.textContent = i18n['profile.less'] || 'Show Less';
            icon.style.transform = 'rotate(180deg)';
            isProfileExpanded = true;
        } else {
            details.classList.add('hidden');
            text.textContent = i18n['profile.more'] || 'Show More Details';
            icon.style.transform = 'rotate(0deg)';
            isProfileExpanded = false;
        }
    };

    function createDetailItem(label, value) {
        return `
            <div class="detail-item">
                <span class="detail-label">${label}</span>
                <span class="detail-value">${value}</span>
            </div>
        `;
    }

    function renderModelCard(model, pinnedModels) {
        const pct = model.remainingPercentage || 0;
        const color = getHealthColor(pct);
        const isPinned = pinnedModels.includes(model.modelId);


        const card = document.createElement('div');
        card.className = 'card draggable';
        card.setAttribute('draggable', 'true');
        card.setAttribute('data-id', model.modelId);

        // 绑定拖拽事件
        card.addEventListener('dragstart', handleDragStart, false);
        card.addEventListener('dragenter', handleDragEnter, false);
        card.addEventListener('dragover', handleDragOver, false);
        card.addEventListener('dragleave', handleDragLeave, false);
        card.addEventListener('drop', handleDrop, false);
        card.addEventListener('dragend', handleDragEnd, false);

        card.innerHTML = `
            <div class="card-title">
                <span class="drag-handle" data-tooltip="${i18n['dashboard.dragHint'] || 'Drag to reorder'}">⋮⋮</span>
                <span class="label" title="${model.modelId}">${model.label}</span>
                <div class="actions">
                    <label class="switch" data-tooltip="${i18n['dashboard.pinHint'] || 'Pin to Status Bar'}">
                        <input type="checkbox" class="pin-toggle" data-model-id="${model.modelId}" ${isPinned ? 'checked' : ''}>
                        <span class="slider"></span>
                    </label>
                    <span class="status-dot" style="background-color: ${color}"></span>
                </div>
            </div>
            <div class="progress-circle" style="background: conic-gradient(${color} ${pct}%, var(--border-color) ${pct}%);">
                <div class="percentage">${pct.toFixed(2)}%</div>
            </div>
            <div class="info-row">
                <span>${i18n['dashboard.resetIn'] || 'Reset In'}</span>
                <span class="info-value">${model.timeUntilResetFormatted}</span>
            </div>
            <div class="info-row">
                <span>${i18n['dashboard.resetTime'] || 'Reset Time'}</span>
                <span class="info-value small">${model.resetTimeDisplay || 'N/A'}</span>
            </div>
            <div class="info-row">
                <span>${i18n['dashboard.status'] || 'Status'}</span>
                <span class="info-value" style="color: ${color}">
                    ${model.isExhausted 
                        ? (i18n['dashboard.exhausted'] || 'Exhausted') 
                        : (i18n['dashboard.active'] || 'Active')}
                </span>
            </div>
        `;
        dashboard.appendChild(card);
    }

    // ============ 启动 ============

    init();

})();
