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

const upload = multer({ dest: 'prompts/' });

// Ensure prompts directory exists
if (!fs.existsSync(path.join(__dirname, 'prompts'))) {
    fs.mkdirSync(path.join(__dirname, 'prompts'));
}

// Global state to track running process
let currentProcess = null;

// Native File/Folder pickers for Windows
app.get('/api/pick-folder', (req, res) => {
    const child = spawn('powershell', ['-Sta', '-NoProfile', '-File', path.join(__dirname, 'pick-folder.ps1')]);
    let folderPath = '';
    child.stdout.on('data', data => folderPath += data.toString());
    child.on('close', () => res.json({ path: folderPath.trim() }));
});

app.get('/api/pick-file', (req, res) => {
    const child = spawn('powershell', ['-Sta', '-NoProfile', '-File', path.join(__dirname, 'pick-file.ps1')]);
    let filePath = '';
    child.stdout.on('data', data => filePath += data.toString());
    child.on('close', () => res.json({ path: filePath.trim() }));
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

    currentProcess = spawn('node', ['index.js', '--login', '--provider', provider], { cwd: __dirname });

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
        promptFilePath = path.join(__dirname, 'prompts', `web_prompt_${Date.now()}.txt`);
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
    const args = ['index.js', '-p', promptFilePath, '-f', folder, '--provider', providerFlag, '--media-type', mediaTypeFlag];
    if (useFlow) args.push('--flow');
    if (aspectRatio) args.push('--aspect-ratio', aspectRatio);
    currentProcess = spawn('node', args, { cwd: __dirname });

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
