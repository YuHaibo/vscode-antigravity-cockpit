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

    // State for profile toggle and privacy
    let isProfileExpanded = false;
    let isPrivacyMode = false;
    let isProfileVisible = true; // New state for overall visibility

    // Icons
    const ICON_EYE = `<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M8 3C4.5 3 1.5 5.5 1.5 8S4.5 13 8 13s6.5-2.5 6.5-5S11.5 3 8 3zm0 9c-2.5 0-5-1.8-5-4s2.5-4 5-4 5 1.8 5 4-2.5 4-5 4z"/><path d="M8 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/></svg>`;
    const ICON_EYE_SLASH = `<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M13.359 11.238C15.06 9.72 16 8 16 8s-3-5.5-8-5.5a7.028 7.028 0 0 0-2.79.588l.77.771A5.944 5.944 0 0 1 8 3.5c2.12 0 3.879 1.168 5.168 2.457A13.134 13.134 0 0 1 14.828 8c-.058.087-.122.183-.195.288-.335.48-.83 1.12-1.465 1.755-.165.165-.337.328-.517.486l.708.709z"/><path d="M11.297 9.176a3.5 3.5 0 0 0-4.474-4.474l.823.823a2.501 2.501 0 0 1 2.829 2.829l.822.822zm-2.943 1.299.822.822a3.5 3.5 0 0 1-4.474-4.474l.823.823a2.501 2.501 0 0 0 2.829 2.829z"/><path d="M3.35 5.47c-.18.16-.353.322-.518.487A13.134 13.134 0 0 0 1.172 8l.195.288c.335.48.83 1.12 1.465 1.755C4.121 11.332 5.881 12.5 8 12.5c.716 0 1.39-.133 2.02-.36l.77.772A7.029 7.029 0 0 1 8 13.5C3 13.5 0 8 0 8s3-5.5 8-5.5c1.724 0 3.229.742 4.316 1.945L12.062 4.7A5.994 5.994 0 0 0 8 3.5c-1.748 0-3.268.804-4.65 1.97z"/><path d="M1.646 2.646a.5.5 0 0 1 .708 0l11 11a.5.5 0 0 1-.708.708l-11-11a.5.5 0 0 1 0-.708z"/></svg>`;
    const ICON_CHEVRON_UP = `<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path fill-rule="evenodd" d="M7.646 4.646a.5.5 0 0 1 .708 0l6 6a.5.5 0 0 1-.708.708L8 5.707l-5.646 5.647a.5.5 0 0 1-.708-.708l6-6z"/></svg>`;
    const ICON_CHEVRON_DOWN = `<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path fill-rule="evenodd" d="M1.646 4.646a.5.5 0 0 1 .708 0L8 10.293l5.646-5.647a.5.5 0 0 1 .708.708l-6 6a.5.5 0 0 1-.708 0l-6-6a.5.5 0 0 1 0-.708z"/></svg>`;

    // Store userInfo for re-rendering on toggle
    let lastUserInfo = null;

    function renderUserProfile(userInfo) {
        lastUserInfo = userInfo;
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
        
        // Privacy icon
        const privacyIcon = isPrivacyMode ? ICON_EYE_SLASH : ICON_EYE;
        const privacyTitle = isPrivacyMode ? 'Show sensitive data' : 'Hide sensitive data';

        // Collapse icon
        const collapseIcon = isProfileVisible ? ICON_CHEVRON_UP : ICON_CHEVRON_DOWN;
        const collapseTitle = isProfileVisible ? 'Collapse Profile' : 'Expand Profile';
        const contentClass = isProfileVisible ? 'profile-content' : 'profile-content hidden';

        card.innerHTML = `
            <div class="card-title">
                <span class="label">${i18n['profile.details'] || 'User Profile'}</span>
                <div class="header-actions">
                    <button class="icon-btn" id="privacy-toggle" title="${privacyTitle}">
                        ${privacyIcon}
                    </button>
                    <button class="icon-btn" id="visibility-toggle" title="${collapseTitle}">
                        ${collapseIcon}
                    </button>
                    <div class="tier-badge">${userInfo.tier}</div>
                </div>
            </div>
            
            <div id="profile-main-content" class="${contentClass}">
                <div class="profile-grid">
                    ${createDetailItem(i18n['profile.email'] || 'Email', userInfo.email, true)}
                    ${createDetailItem(i18n['profile.description'] || 'Description', userInfo.tierDescription)}
                    ${createDetailItem(i18n['feature.webSearch'] || 'Web Search', getFeatureStatus(userInfo.cascadeWebSearchEnabled))}
                    ${createDetailItem(i18n['feature.browser'] || 'Browser Access', getFeatureStatus(userInfo.browserEnabled))}
                    ${createDetailItem(i18n['feature.knowledgeBase'] || 'Knowledge Base', getFeatureStatus(userInfo.knowledgeBaseEnabled))}
                    ${createDetailItem(i18n['feature.mcp'] || 'MCP Servers', getFeatureStatus(userInfo.allowMcpServers))}
                    ${createDetailItem(i18n['feature.gitCommit'] || 'Git Commit', getFeatureStatus(userInfo.canGenerateCommitMessages))}
                    ${createDetailItem(i18n['feature.context'] || 'Context Window', userInfo.maxNumChatInputTokens)}
                </div>

                <div class="${detailsClass}" id="profile-more">
                    <div class="profile-grid">
                        ${createDetailItem(i18n['feature.fastMode'] || 'Fast Mode', getFeatureStatus(userInfo.hasAutocompleteFastMode))}
                        ${createDetailItem(i18n['feature.moreCredits'] || 'Can Buy Credits', getFeatureStatus(userInfo.canBuyMoreCredits))}
                        
                        ${createDetailItem(i18n['profile.teamsTier'] || 'Teams Tier', userInfo.teamsTier)}
                        ${createDetailItem(i18n['profile.userId'] || 'Internal Tier ID', userInfo.userTierId || 'N/A', true)}
                        ${createDetailItem(i18n['profile.tabToJump'] || 'Tab To Jump', getFeatureStatus(userInfo.hasTabToJump))}
                        ${createDetailItem(i18n['profile.stickyModels'] || 'Sticky Models', getFeatureStatus(userInfo.allowStickyPremiumModels))}
                        ${createDetailItem(i18n['profile.commandModels'] || 'Command Models', getFeatureStatus(userInfo.allowPremiumCommandModels))}
                        ${createDetailItem(i18n['profile.maxPremiumMsgs'] || 'Max Premium Msgs', userInfo.maxNumPremiumChatMessages)}
                        ${createDetailItem(i18n['profile.chatInstructionsCharLimit'] || 'Chat Instructions Char Limit', userInfo.maxCustomChatInstructionCharacters)}
                        ${createDetailItem(i18n['profile.pinnedContextItems'] || 'Pinned Context Items', userInfo.maxNumPinnedContextItems)}
                        ${createDetailItem(i18n['profile.localIndexSize'] || 'Local Index Size', userInfo.maxLocalIndexSize)}
                        ${createDetailItem(i18n['profile.acceptedTos'] || 'Accepted TOS', getFeatureStatus(userInfo.acceptedLatestTermsOfService))}
                        ${createDetailItem(i18n['profile.customizeIcon'] || 'Customize Icon', getFeatureStatus(userInfo.canCustomizeAppIcon))}
                        ${createDetailItem(i18n['profile.cascadeAutoRun'] || 'Cascade Auto Run', getFeatureStatus(userInfo.cascadeCanAutoRunCommands))}
                        ${createDetailItem(i18n['profile.cascadeBackground'] || 'Cascade Background', getFeatureStatus(userInfo.canAllowCascadeInBackground))}
                        ${createDetailItem(i18n['profile.autoRunCommands'] || 'Auto Run Commands', getFeatureStatus(userInfo.allowAutoRunCommands))}
                        ${createDetailItem(i18n['profile.expBrowserFeatures'] || 'Exp. Browser Features', getFeatureStatus(userInfo.allowBrowserExperimentalFeatures))}
                    </div>
                    ${upgradeHtml}
                </div>

                <div class="profile-toggle">
                    <button class="btn-text" id="profile-toggle-btn">
                        <span id="profile-toggle-text">${toggleText}</span> 
                        <span id="profile-toggle-icon" style="transform: ${iconTransform}">▼</span>
                    </button>
                </div>
            </div>
        `;
        dashboard.appendChild(card);
        
        // Bind event listeners
        const toggleBtn = card.querySelector('#profile-toggle-btn');
        if (toggleBtn) {
            toggleBtn.addEventListener('click', toggleProfileDetails);
        }

        const privacyBtn = card.querySelector('#privacy-toggle');
        if (privacyBtn) {
            privacyBtn.addEventListener('click', togglePrivacyMode);
        }

        const visibilityBtn = card.querySelector('#visibility-toggle');
        if (visibilityBtn) {
            visibilityBtn.addEventListener('click', toggleProfileVisibility);
        }
    }

    // Toggle detailed profile info
    function toggleProfileDetails() {
        // Update state but don't re-render entire card to avoid flicker
        isProfileExpanded = !isProfileExpanded;
        const details = document.getElementById('profile-more');
        const text = document.getElementById('profile-toggle-text');
        const icon = document.getElementById('profile-toggle-icon');
        
        if (isProfileExpanded) {
            details.classList.remove('hidden');
            text.textContent = i18n['profile.less'] || 'Show Less';
            icon.style.transform = 'rotate(180deg)';
        } else {
            details.classList.add('hidden');
            text.textContent = i18n['profile.more'] || 'Show More Details';
            icon.style.transform = 'rotate(0deg)';
        }
        
        // Save state
        const state = vscode.getState() || {};
        vscode.setState({ ...state, isProfileExpanded });
    };

    function togglePrivacyMode() {
        isPrivacyMode = !isPrivacyMode;
        
        // Save state
        const state = vscode.getState() || {};
        vscode.setState({ ...state, isPrivacyMode });

        // Re-render entire dashboard to maintain order
        if (lastSnapshot) {
            render(lastSnapshot, lastConfig);
        }
    }

    function toggleProfileVisibility() {
        isProfileVisible = !isProfileVisible;
        
        // Save state
        const state = vscode.getState() || {};
        vscode.setState({ ...state, isProfileVisible });

        // Re-render to update icon and visibility
        if (lastSnapshot) {
            render(lastSnapshot, lastConfig);
        }
    }

    function createDetailItem(label, value, sensitive = false) {
        let displayValue = value;
        if (sensitive && isPrivacyMode) {
            displayValue = '******';
        }
        return `
            <div class="detail-item">
                <span class="detail-label">${label}</span>
                <span class="detail-value ${sensitive && isPrivacyMode ? 'masked' : ''}">${displayValue}</span>
            </div>
        `;
    } 
    
    // ... inside init() ...
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
        if (typeof state.isProfileExpanded !== 'undefined') isProfileExpanded = state.isProfileExpanded;
        if (typeof state.isPrivacyMode !== 'undefined') isPrivacyMode = state.isPrivacyMode;
        if (typeof state.isProfileVisible !== 'undefined') isProfileVisible = state.isProfileVisible;
    
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

    let lastSnapshot = null;
    let lastConfig = null;


    // ============ 渲染 ============

    function render(snapshot, config) {
        lastSnapshot = snapshot;
        lastConfig = config;

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



    // ============ 启动 ============

    init();

})();
