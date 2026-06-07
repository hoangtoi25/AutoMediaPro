document.addEventListener('DOMContentLoaded', () => {
    // --- Initial Checks ---
    fetch('/api/settings')
        .then(res => res.json())
        .then(data => {
            if (data.browserPath) {
                const el = document.getElementById('browserPath');
                if (el) el.value = data.browserPath;
            }
            verifyBrowserPath();
        })
        .catch(console.error);

    fetch('/api/check-chrome')
        .then(res => res.json())
        .then(data => {
            if (!data.installed) {
                alert('⚠️ CẢNH BÁO QUAN TRỌNG: Máy tính của bạn chưa cài đặt trình duyệt Google Chrome!\n\nAutoMedia Pro yêu cầu phải có Chrome để chạy tự động hóa. Vui lòng tải và cài đặt Chrome trước khi sử dụng tính năng Generate.');
            }
        })
        .catch(console.error);

    // --- Navigation Logic ---
    const stepItems = document.querySelectorAll('.step-item');
    const stepContents = document.querySelectorAll('.step-content');
    const nextBtns = document.querySelectorAll('.btn-next');
    const prevBtns = document.querySelectorAll('.btn-prev');

    function goToStep(stepNumber) {
        // Update Sidebar
        stepItems.forEach(item => {
            if (item.dataset.step == stepNumber) {
                item.classList.add('active');
            } else {
                item.classList.remove('active');
            }
        });

        // Update Content
        stepContents.forEach(content => {
            if (content.id === `step-${stepNumber}-content`) {
                content.classList.add('active');
            } else {
                content.classList.remove('active');
            }
        });

        // Update Output Folder in Step 2 Preview if they navigate manually
        if (stepNumber == 2) {
            const currentFolder = document.getElementById('folderName').value.trim();
            const outputFolderElement = document.getElementById('output-folder-name');
            if (outputFolderElement) {
                outputFolderElement.innerText = currentFolder || '...';
            }
        }
    }

    nextBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
            const target = parseInt(e.currentTarget.dataset.target);

            // Validate Step 1 → Step 2
            if (target === 2) {
                const folderName = document.getElementById('folderName').value.trim();
                if (!folderName) {
                    alert('⚠️ Vui lòng nhập Output Folder Name!');
                    return;
                }

                // Validate prompt input
                const activeTab = document.querySelector('.tab-btn.active');
                const inputType = activeTab ? activeTab.dataset.tab : 'upload';
                if (inputType === 'upload') {
                    if (!selectedFile && !nativeFilePath) {
                        alert('⚠️ Vui lòng chọn file prompts trước khi chuyển sang bước tiếp theo!');
                        return;
                    }
                } else {
                    const text = document.getElementById('promptText').value.trim();
                    if (!text) {
                        alert('⚠️ Vui lòng nhập nội dung prompts trước khi chuyển sang bước tiếp theo!');
                        return;
                    }
                }

                // Pre-populate prompt preview in Step 3
                previewPromptsInQueue();
            }

            goToStep(target);
        });
    });

    prevBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
            const target = e.currentTarget.dataset.target;
            goToStep(target);
        });
    });

    // --- Tab Logic ---
    const tabBtns = document.querySelectorAll('.tab-btn');
    const tabContents = document.querySelectorAll('.tab-content');
    let activeInputType = 'upload'; // 'upload' or 'paste'

    tabBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
            tabBtns.forEach(b => b.classList.remove('active'));
            e.currentTarget.classList.add('active');
            
            const targetTab = e.currentTarget.dataset.tab;
            activeInputType = targetTab;
            
            tabContents.forEach(c => {
                if (c.id === `tab-${targetTab}`) c.classList.add('active');
                else c.classList.remove('active');
            });
        });
    });

    // --- Provider Selection Logic ---
    let selectedProvider = 'imagefx';
    const providerCards = document.querySelectorAll('.provider-card-full');
    providerCards.forEach(card => {
        card.addEventListener('click', (e) => {
            // Don't trigger selection when clicking the login button
            if (e.target.closest('.btn-login-inline')) return;
            providerCards.forEach(c => c.classList.remove('active'));
            card.classList.add('active');
            selectedProvider = card.dataset.provider;
        });
    });

    // --- Media Type Toggle Logic ---
    let selectedMediaType = 'image'; // 'image' or 'video'
    let selectedAspectRatio = '9:16';
    const mediaTypeBtns = document.querySelectorAll('.media-type-btn');
    const aspectRatioSelector = document.getElementById('aspect-ratio-selector');
    
    mediaTypeBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            mediaTypeBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            selectedMediaType = btn.dataset.type;
            
            // Always show aspect ratio selector (available for all media types)
            aspectRatioSelector.style.display = 'flex';
        });
    });

    const aspectRatioBtns = document.querySelectorAll('.aspect-ratio-btn');
    aspectRatioBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            aspectRatioBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            selectedAspectRatio = btn.dataset.ratio;
        });
    });

    // --- Input Method Toggle Logic ---
    let selectedInputMethod = 'typing'; // 'typing' or 'paste'
    const inputMethodBtns = document.querySelectorAll('.input-method-btn');
    
    inputMethodBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            inputMethodBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            selectedInputMethod = btn.dataset.method;
        });
    });

    // --- File Drag & Drop Logic ---
    const dropZone = document.getElementById('file-drop-zone');
    const fileInput = document.getElementById('promptFile');
    const fileNameDisplay = document.getElementById('selected-file-name');
    let selectedFile = null;
    let nativeFilePath = null;
    let nativeFolderPath = null;

    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, preventDefaults, false);
    });

    function preventDefaults(e) {
        e.preventDefault();
        e.stopPropagation();
    }

    ['dragenter', 'dragover'].forEach(eventName => {
        dropZone.addEventListener(eventName, () => dropZone.classList.add('dragover'), false);
    });

    ['dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, () => dropZone.classList.remove('dragover'), false);
    });

    dropZone.addEventListener('drop', (e) => {
        const dt = e.dataTransfer;
        const files = dt.files;
        handleFiles(files);
    });

    fileInput.addEventListener('change', function() {
        handleFiles(this.files);
    });

    function handleFiles(files) {
        if (files.length > 0) {
            selectedFile = files[0];
            const fileExt = selectedFile.name.substring(selectedFile.name.lastIndexOf('.')).toLowerCase();
            if (fileExt !== '.txt' && fileExt !== '.md') {
                alert('⚠️ Cảnh báo: Định dạng file không hợp lệ!\nVui lòng chỉ chọn file .txt hoặc .md.');
                selectedFile = null;
                fileNameDisplay.textContent = 'No file selected';
                fileNameDisplay.style.color = '';
                return;
            }
            nativeFilePath = null; // Clear native file if uploading web
            fileNameDisplay.textContent = selectedFile.name;
            fileNameDisplay.style.color = '#10b981'; // Success color
        }
    }

    // --- Native Folder Picker ---
    const btnPickFolder = document.getElementById('btn-pick-folder');
    if (btnPickFolder) {
        btnPickFolder.addEventListener('click', async () => {
            try {
                const res = await fetch('/api/pick-folder');
                const data = await res.json();
                if (data.path) {
                    document.getElementById('folderName').value = data.path;
                    nativeFolderPath = data.path;
                }
            } catch (err) {
                console.error('Pick folder error:', err);
            }
        });
    }

    const folderInput = document.getElementById('folderName');
    if (folderInput) {
        folderInput.addEventListener('input', () => {
            nativeFolderPath = null;
        });
    }

    // --- Native File Picker ---
    const btnPickFile = document.getElementById('btn-pick-file');
    if (btnPickFile) {
        btnPickFile.addEventListener('click', async () => {
            try {
                const res = await fetch('/api/pick-file');
                const data = await res.json();
                if (data.path) {
                    nativeFilePath = data.path;
                    selectedFile = null; // Clear web-uploaded file
                    fileInput.value = ''; // Reset file input
                    
                    // Display file name (get base name from path)
                    const filename = data.path.split(/[\\/]/).pop();
                    fileNameDisplay.textContent = filename + ' (Local)';
                    fileNameDisplay.style.color = '#10b981'; // Success color
                    
                    previewPromptsInQueue();
                }
            } catch (err) {
                console.error('Pick file error:', err);
            }
        });
    }

    // --- Native Browser Picker ---
    const btnPickBrowser = document.getElementById('btn-pick-browser');
    const browserPathInput = document.getElementById('browserPath');

    if (btnPickBrowser) {
        btnPickBrowser.addEventListener('click', async () => {
            try {
                const res = await fetch('/api/pick-browser');
                const data = await res.json();
                if (data.path) {
                    browserPathInput.value = data.path;
                    await saveBrowserPath(data.path);
                    verifyBrowserPath();
                }
            } catch (err) {
                console.error('Pick browser error:', err);
            }
        });
    }

    if (browserPathInput) {
        browserPathInput.addEventListener('change', async () => {
            await saveBrowserPath(browserPathInput.value);
            verifyBrowserPath();
        });
    }

    async function saveBrowserPath(path) {
        try {
            await fetch('/api/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ browserPath: path })
            });
        } catch (err) {
            console.error('Save settings error:', err);
        }
    }

    async function verifyBrowserPath() {
        const statusEl = document.getElementById('browser-status');
        if (!statusEl) return;
        
        statusEl.className = 'login-badge checking';
        statusEl.innerHTML = '<i class="ph ph-spinner-gap"></i> Đang kiểm tra...';
        
        try {
            const res = await fetch('/api/check-chrome');
            const data = await res.json();
            if (data.installed) {
                statusEl.className = 'login-badge logged-in';
                statusEl.innerHTML = '<i class="ph-fill ph-check-circle"></i> Trình duyệt hợp lệ';
            } else {
                statusEl.className = 'login-badge not-logged-in';
                statusEl.innerHTML = '<i class="ph ph-warning"></i> File không tồn tại';
            }
        } catch (err) {
            console.error('Verify browser error:', err);
            statusEl.className = 'login-badge unknown';
            statusEl.innerHTML = '<i class="ph ph-question"></i> Lỗi kiểm tra';
        }
    }

    // --- Status Indicator Logic ---
    const statusDot = document.getElementById('system-status-dot');
    const statusText = document.getElementById('system-status-text');

    function setSystemStatus(isRunning) {
        if (isRunning) {
            statusDot.classList.add('running');
            statusText.textContent = 'Running';
        } else {
            statusDot.classList.remove('running');
            statusText.textContent = 'Ready';
        }
    }

    // --- Terminal Logic ---
    const terminalOutput = document.getElementById('terminal-output');

    function addLogLine(text, type = 'info') {
        const line = document.createElement('div');
        line.className = `log-line ${type}`;
        
        // Basic parsing for colors from chalk output or keywords
        if (text.includes('Thành công') || text.includes('success')) type = 'success';
        if (text.includes('Lỗi') || text.includes('error')) type = 'error';
        if (text.includes('Cảnh báo')) type = 'warn';
        if (text.includes('▶')) type = 'step';
        
        line.className = `log-line ${type}`;
        line.textContent = text;
        terminalOutput.appendChild(line);
        terminalOutput.scrollTop = terminalOutput.scrollHeight;
    }

    // --- Login Status ---
    function setLoginStatus(providerName, status) {
        // status: 'unknown' | 'checking' | 'logged-in' | 'not-logged-in'
        const badgeId = providerName === 'meta-ai' ? 'login-status-meta-ai' : 'login-status-imagefx';
        const badge = document.getElementById(badgeId);
        if (!badge) return;

        badge.className = `login-badge ${status}`;

        const iconMap = {
            'unknown': '<i class="ph ph-question"></i> Chưa kiểm tra',
            'checking': '<i class="ph ph-spinner-gap"></i> Đang kiểm tra...',
            'logged-in': '<i class="ph-fill ph-check-circle"></i> Đã đăng nhập',
            'not-logged-in': '<i class="ph ph-warning"></i> Chưa đăng nhập',
        };
        badge.innerHTML = iconMap[status] || iconMap['unknown'];
    }

    // --- API Calls ---
    
    // Login — ImageFX (Google)
    document.getElementById('btn-login-imagefx').addEventListener('click', async (e) => {
        e.stopPropagation();
        await handleLogin('imagefx');
    });

    // Login — Meta AI (Facebook)
    document.getElementById('btn-login-meta').addEventListener('click', async (e) => {
        e.stopPropagation();
        await handleLogin('meta-ai');
    });

    async function handleLogin(provider) {
        terminalOutput.innerHTML = '';
        const displayName = provider === 'meta-ai' ? 'Meta AI (Facebook)' : 'ImageFX (Google)';
        addLogLine(`Khởi động tiến trình login ${displayName}...`, 'info');
        setSystemStatus(true);
        setLoginStatus(provider, 'checking');
        
        try {
            const response = await fetch('/api/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ provider }),
            });
            if (!response.ok) {
                const err = await response.json();
                addLogLine(`Error: ${err.error}`, 'error');
                setSystemStatus(false);
                setLoginStatus(provider, 'not-logged-in');
                return;
            }
            
            setupEventSource(response, () => {
                // On completion callback — assume login succeeded
                setLoginStatus(provider, 'logged-in');
            });
            
        } catch (error) {
            addLogLine(`Connection error: ${error.message}`, 'error');
            setSystemStatus(false);
            setLoginStatus(provider, 'not-logged-in');
        }
    }

    // Start Generation
    const btnStart = document.getElementById('btn-start');
    const btnStop = document.getElementById('btn-stop');

    btnStart.addEventListener('click', async () => {
        let folderName = document.getElementById('folderName').value.trim();
        
        if (!folderName) {
            alert('⚠️ Vui lòng nhập Output Folder Name!');
            goToStep(1);
            return;
        }

        // Show warning about minimizing Chrome
        alert('⚠️ LƯU Ý QUAN TRỌNG:\n\nVui lòng KHÔNG thu nhỏ (minimize) cửa sổ Chrome trong suốt quá trình tool đang chạy để tránh bị kẹt ảnh.\n\nBạn có thể làm việc trên cửa sổ khác đè lên Chrome, nhưng tuyệt đối không ấn nút thu nhỏ (-) nhé!');

        const formData = new FormData();
        formData.append('folderName', folderName);

        if (activeInputType === 'upload') {
            if (!selectedFile && !nativeFilePath) {
                alert('⚠️ Vui lòng chọn file prompts');
                return;
            }
            if (selectedFile) {
                formData.append('promptFile', selectedFile);
            } else if (nativeFilePath) {
                formData.append('nativeFilePath', nativeFilePath);
            }
        } else {
            const text = document.getElementById('promptText').value;
            if (!text.trim()) {
                alert('⚠️ Vui lòng nhập nội dung prompts');
                return;
            }
            
            // Basic validation for text format
            const lines = text.split('\\n').map(l => l.trim()).filter(l => l.length > 0 && !l.startsWith('#'));
            if (lines.length === 0) {
                alert('⚠️ Cảnh báo: Nội dung prompts không hợp lệ!\nHãy nhập mỗi prompt trên một dòng (bỏ qua dòng trống và dòng bắt đầu bằng #).');
                return;
            }
            
            formData.append('promptText', text);
        }

        // Display the output folder in Step 3
        document.getElementById('output-folder-name').innerText = folderName;

        // Add provider to form data
        formData.append('provider', selectedProvider);
        formData.append('mediaType', selectedMediaType);
        formData.append('aspectRatio', selectedAspectRatio);
        formData.append('inputMethod', selectedInputMethod);
        if (selectedMediaType === 'flow') {
            formData.append('flowMode', 'true');
        }

        terminalOutput.innerHTML = '';
        const modeLabel = selectedMediaType === 'flow' ? 'Flow (Image → Video)' : selectedMediaType === 'video' ? 'video' : 'ảnh';
        addLogLine(`Khởi động tiến trình tạo ${modeLabel} (Folder: ${folderName})...`, 'info');
        setSystemStatus(true);
        
        btnStart.disabled = true;
        btnStop.disabled = false;

        try {
            const response = await fetch('/api/generate', {
                method: 'POST',
                body: formData
            });

            if (!response.ok) {
                const err = await response.json();
                addLogLine(`Error: ${err.error}`, 'error');
                setSystemStatus(false);
                btnStart.disabled = false;
                btnStop.disabled = true;
                return;
            }

            setupEventSource(response);

        } catch (error) {
            addLogLine(`Connection error: ${error.message}`, 'error');
            setSystemStatus(false);
            btnStart.disabled = false;
            btnStop.disabled = true;
        }
    });

    // Stop
    btnStop.addEventListener('click', async () => {
        try {
            await fetch('/api/stop', { method: 'POST' });
            addLogLine('Đã gửi lệnh dừng...', 'warn');
        } catch (e) {
            addLogLine(`Lỗi khi dừng: ${e.message}`, 'error');
        }
    });

    async function setupEventSource(response, onComplete) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            
            // SSE lines end with \n\n
            let endOfEvent = buffer.indexOf('\n\n');
            while (endOfEvent !== -1) {
                const eventText = buffer.slice(0, endOfEvent).trim();
                buffer = buffer.slice(endOfEvent + 2);
                endOfEvent = buffer.indexOf('\n\n');

                if (eventText.startsWith('data: ')) {
                    try {
                        const dataStr = eventText.slice(6);
                        const data = JSON.parse(dataStr);
                        
                        if (data.type === 'log' || data.type === 'error') {
                            const lines = data.message.split('\n').filter(l => l.trim() !== '');
                            lines.forEach(line => {
                                // remove ascii color codes
                                const cleanLine = line.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
                                
                                if (cleanLine.startsWith('[SYSTEM] PROMPTS_LIST:')) {
                                    try {
                                        const promptList = JSON.parse(cleanLine.substring(22));
                                        buildPromptQueueUI(promptList);
                                    } catch (err) { console.error('Parse prompt list error:', err); }
                                    return;
                                }

                                if (cleanLine.startsWith('[SYSTEM] FLOW_PAIRS:')) {
                                    try {
                                        const pairs = JSON.parse(cleanLine.substring(20));
                                        buildFlowQueueUI(pairs);
                                    } catch (err) { console.error('Parse flow pairs error:', err); }
                                    return;
                                }

                                updatePromptStatusFromLog(cleanLine);
                                
                                addLogLine(cleanLine, data.type === 'error' ? 'error' : 'info');
                            });
                        } else if (data.type === 'close') {
                            addLogLine(data.message, 'warn');
                            setSystemStatus(false);
                            btnStart.disabled = false;
                            btnStop.disabled = true;
                        }
                    } catch (e) {
                        console.error('Error parsing SSE', e);
                    }
                }
            }
        }
        
        setSystemStatus(false);
        btnStart.disabled = false;
        btnStop.disabled = true;
        if (onComplete) onComplete();
    }

    let currentPromptList = [];
    let completedCount = 0;

    function buildPromptQueueUI(prompts) {
        currentPromptList = prompts;
        completedCount = 0;
        const listDiv = document.getElementById('prompt-queue-list');
        const statusSpan = document.getElementById('queue-status');
        
        statusSpan.innerText = `0/${prompts.length}`;
        listDiv.innerHTML = '';
        
        prompts.forEach((p, idx) => {
            const item = document.createElement('div');
            item.className = 'prompt-item pending';
            item.id = `queue-item-${idx + 1}`;
            
            const num = document.createElement('div');
            num.className = 'prompt-item-index';
            num.innerText = `#${idx + 1}`;
            
            const text = document.createElement('div');
            text.className = 'prompt-item-text';
            text.innerText = p;
            
            const icon = document.createElement('i');
            icon.className = 'ph ph-hourglass-high prompt-item-icon';
            icon.id = `queue-icon-${idx + 1}`;
            
            item.appendChild(num);
            item.appendChild(text);
            item.appendChild(icon);
            listDiv.appendChild(item);
        });
    }

    function buildFlowQueueUI(pairs) {
        currentPromptList = pairs;
        completedCount = 0;
        const listDiv = document.getElementById('prompt-queue-list');
        const statusSpan = document.getElementById('queue-status');

        statusSpan.innerText = `0/${pairs.length}`;
        listDiv.innerHTML = '';

        pairs.forEach((pair, idx) => {
            const item = document.createElement('div');
            item.className = 'prompt-item pending';
            item.id = `queue-item-${pair.index}`;

            const num = document.createElement('div');
            num.className = 'prompt-item-index';
            num.innerText = `#${pair.index}`;

            const textWrapper = document.createElement('div');
            textWrapper.className = 'prompt-item-text';

            const imgLine = document.createElement('div');
            imgLine.style.cssText = 'font-size: 0.8rem; margin-bottom: 0.3rem; opacity: 0.8;';
            imgLine.innerHTML = `🎨 ${pair.imagePrompt.substring(0, 60)}...`;

            const vidLine = document.createElement('div');
            vidLine.style.cssText = 'font-size: 0.8rem; opacity: 0.6;';
            vidLine.innerHTML = `🎬 ${pair.videoPrompt.substring(0, 60)}...`;

            textWrapper.appendChild(imgLine);
            textWrapper.appendChild(vidLine);

            const icon = document.createElement('i');
            icon.className = 'ph ph-hourglass-high prompt-item-icon';
            icon.id = `queue-icon-${pair.index}`;

            item.appendChild(num);
            item.appendChild(textWrapper);
            item.appendChild(icon);
            listDiv.appendChild(item);
        });
    }

    function updatePromptStatusFromLog(logText) {
        const startMatch = logText.match(/Đang xử lý prompt #(\d+)/);
        if (startMatch) {
            setQueueItemStatus(startMatch[1], 'running', 'ph-spinner gap');
            return;
        }
        
        const successMatch = logText.match(/✅ Prompt #(\d+):/);
        if (successMatch) {
            setQueueItemStatus(successMatch[1], 'success', 'ph-check-circle');
            updateCompletedCount();
            return;
        }
        
        const errMatch = logText.match(/Prompt #(\d+): (.+)/);
        if (errMatch && !logText.includes('trùng URL')) {
            const idx = errMatch[1];
            const msg = errMatch[2].toLowerCase();
            if (msg.includes('bỏ qua') || logText.includes('thất bại') || msg.includes('timeout') || msg.includes('error')) {
                setQueueItemStatus(idx, 'error', 'ph-warning-circle');
                updateCompletedCount();
            }
        }
    }

    function setQueueItemStatus(idx, status, iconClass) {
        const item = document.getElementById(`queue-item-${idx}`);
        const icon = document.getElementById(`queue-icon-${idx}`);
        if (item && icon) {
            item.className = `prompt-item ${status}`;
            icon.className = `prompt-item-icon ph ${iconClass}`;
            item.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
    }

    function updateCompletedCount() {
        completedCount++;
        const statusSpan = document.getElementById('queue-status');
        if (statusSpan && currentPromptList.length > 0) {
            statusSpan.innerText = `${completedCount}/${currentPromptList.length}`;
        }
    }

    async function previewPromptsInQueue() {
        const activeTab = document.querySelector('.tab-btn.active');
        const inputType = activeTab ? activeTab.dataset.tab : 'upload';

        if (inputType === 'upload') {
            if (selectedFile) {
                const reader = new FileReader();
                reader.onload = function(e) {
                    const text = e.target.result;
                    const prompts = parsePromptsFromText(text, selectedFile.name);
                    buildPromptQueueUI(prompts);
                };
                reader.readAsText(selectedFile);
            } else if (nativeFilePath) {
                try {
                    const res = await fetch(`/api/read-file?path=${encodeURIComponent(nativeFilePath)}`);
                    const data = await res.json();
                    if (data.content) {
                        const prompts = parsePromptsFromText(data.content, nativeFilePath);
                        buildPromptQueueUI(prompts);
                    }
                } catch (err) {
                    console.error('Error reading native file:', err);
                }
            }
        } else if (inputType === 'paste') {
            const text = document.getElementById('promptText').value;
            const prompts = parsePromptsFromText(text, 'input.txt');
            buildPromptQueueUI(prompts);
        }
    }

    function parsePromptsFromText(text, filename) {
        const lines = text.replace(/\r\n/g, '\n').split('\n');
        const prompts = [];

        for (const rawLine of lines) {
            let line = rawLine.trim();
            if (!line) continue;

            // Skip markdown headers (# Title)
            if (/^#{1,6}\s/.test(line)) continue;

            // Skip horizontal rules (--- or ***)
            if (/^[-*_]{3,}$/.test(line)) continue;

            // Skip code fences
            if (line.startsWith('```')) continue;

            // Skip HTML comments
            if (line.startsWith('<!--')) continue;

            // Skip comment lines (# comment in .txt)
            if (line === '#' || (line.startsWith('#') && !line.startsWith('# '))) continue;

            // Clean up list markers for display
            let prompt = line;
            prompt = prompt.replace(/^[-*+]\s+/, '');
            prompt = prompt.replace(/\*\*(.*?)\*\*/g, '$1');
            prompt = prompt.replace(/\*(.*?)\*/g, '$1');
            prompt = prompt.trim();

            if (prompt.length > 5) {
                prompts.push(prompt);
            }
        }
        return prompts;
    }
});
