import express from 'express';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import multer from 'multer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Determine a writeable prompts directory (handle app.asar path)
let promptsDir = path.join(__dirname, 'prompts');
if (promptsDir.includes('app.asar')) {
    promptsDir = promptsDir.replace('app.asar', 'app.asar.unpacked');
}

// Ensure prompts directory exists
if (!fs.existsSync(promptsDir)) {
    fs.mkdirSync(promptsDir, { recursive: true });
}

const upload = multer({ dest: promptsDir });

// Global state to track running process
let currentProcess = null;

// Native File/Folder pickers for Windows
app.get('/api/pick-folder', (req, res) => {
    let scriptPath = path.join(__dirname, 'pick-folder.ps1');
    if (scriptPath.includes('app.asar')) {
        scriptPath = scriptPath.replace('app.asar', 'app.asar.unpacked');
    }
    const child = spawn('powershell', ['-Sta', '-NoProfile', '-File', scriptPath]);
    let folderPath = '';
    child.stdout.on('data', data => folderPath += data.toString());
    child.on('close', () => res.json({ path: folderPath.trim() }));
});

app.get('/api/pick-file', (req, res) => {
    let scriptPath = path.join(__dirname, 'pick-file.ps1');
    if (scriptPath.includes('app.asar')) {
        scriptPath = scriptPath.replace('app.asar', 'app.asar.unpacked');
    }
    const child = spawn('powershell', ['-Sta', '-NoProfile', '-File', scriptPath]);
    let filePath = '';
    child.stdout.on('data', data => filePath += data.toString());
    child.on('close', () => res.json({ path: filePath.trim() }));
});

app.get('/api/read-file', (req, res) => {
    const filePath = req.query.path;
    if (!filePath) {
        return res.status(400).json({ error: 'Path is required' });
    }
    try {
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: 'File not found' });
        }
        const content = fs.readFileSync(filePath, 'utf-8');
        res.json({ content });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/check-chrome', (req, res) => {
    // Check for portable Chrome bundled with the project
    const portableChrome = path.join(__dirname, 'GoogleChromePortable64', 'App', 'Chrome-bin', 'chrome.exe');
    const installed = fs.existsSync(portableChrome);
    res.json({ installed });
});

app.post('/api/login', (req, res) => {
    if (currentProcess) {
        return res.status(400).json({ error: 'A process is already running.' });
    }

    const provider = req.body?.provider || 'imagefx';

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
    });

    currentProcess = spawn(process.execPath, ['index.js', '--login', '--provider', provider], {
        cwd: __dirname,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    });

    const sendLog = (type, message) => {
        res.write(`data: ${JSON.stringify({ type, message })}\n\n`);
    };

    currentProcess.stdout.on('data', (data) => {
        sendLog('log', data.toString());
    });

    currentProcess.stderr.on('data', (data) => {
        sendLog('error', data.toString());
    });

    currentProcess.on('close', (code) => {
        sendLog('close', `Process exited with code ${code}`);
        res.end();
        currentProcess = null;
    });
});

app.post('/api/generate', upload.single('promptFile'), (req, res) => {
    if (currentProcess) {
        return res.status(400).json({ error: 'A process is already running.' });
    }

    const { folderName, promptText, nativeFilePath } = req.body;
    
    // If it's a JSON body, multer doesn't run, so we handle text directly
    let promptFilePath = '';
    
    if (nativeFilePath) {
        promptFilePath = nativeFilePath;
    } else if (req.file) {
        promptFilePath = req.file.path;
    } else if (promptText) {
        promptFilePath = path.join(promptsDir, `web_prompt_${Date.now()}.txt`);
        fs.writeFileSync(promptFilePath, promptText);
    } else {
        return res.status(400).json({ error: 'No prompt file or text provided.' });
    }

    const folder = req.body.folderName || 'AutoMedia_Web';

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
    });

    const providerFlag = req.body.provider || 'imagefx';
    const mediaTypeFlag = req.body.mediaType || 'image';
    const useFlow = req.body.flowMode === 'true' || req.body.flowMode === true;
    const aspectRatio = req.body.aspectRatio;
    const inputMethod = req.body.inputMethod;
    const args = ['index.js', '-p', promptFilePath, '-f', folder, '--provider', providerFlag, '--media-type', mediaTypeFlag];
    if (useFlow) args.push('--flow');
    if (aspectRatio) args.push('--aspect-ratio', aspectRatio);
    if (inputMethod) args.push('--input-method', inputMethod);
    currentProcess = spawn(process.execPath, args, {
        cwd: __dirname,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    });

    const sendLog = (type, message) => {
        res.write(`data: ${JSON.stringify({ type, message })}\n\n`);
    };

    currentProcess.stdout.on('data', (data) => {
        sendLog('log', data.toString());
    });

    currentProcess.stderr.on('data', (data) => {
        sendLog('error', data.toString());
    });

    currentProcess.on('close', (code) => {
        sendLog('close', `Process exited with code ${code}`);
        res.end();
        currentProcess = null;
    });
});

app.post('/api/stop', (req, res) => {
    if (currentProcess) {
        currentProcess.kill('SIGINT');
        currentProcess = null;
        res.json({ message: 'Process stopped.' });
    } else {
        res.json({ message: 'No process running.' });
    }
});

app.listen(port, () => {
    console.log(`AutoMediaPro UI Server running at http://localhost:${port}`);
});
