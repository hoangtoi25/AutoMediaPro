import { app, BrowserWindow, shell } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import waitOn from 'wait-on';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow;
let serverProcess;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 800,
        title: "AutoMedia Pro",
        icon: path.join(__dirname, 'public', 'icon.png'),
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true
        },
        autoHideMenuBar: true
    });

    // Handle links opening in external browser if needed
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (url.startsWith('http')) {
            shell.openExternal(url);
            return { action: 'deny' };
        }
        return { action: 'allow' };
    });

    // Wait for the Express server to be ready before loading
    const opts = {
        resources: ['http://localhost:3000'],
        delay: 500,
        timeout: 15000
    };

    waitOn(opts)
        .then(() => {
            mainWindow.loadURL('http://localhost:3000');
        })
        .catch(err => {
            console.error('Server wait error:', err);
            mainWindow.loadFile(path.join(__dirname, 'public', 'index.html'));
        });
}

app.whenReady().then(() => {
    // Start the Express server
    serverProcess = spawn(process.execPath, ['server.js'], {
        cwd: __dirname,
        stdio: 'inherit',
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    });

    createWindow();

    app.on('activate', function () {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', function () {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('will-quit', () => {
    if (serverProcess) {
        serverProcess.kill('SIGINT');
    }
});
