const { app, BrowserWindow, globalShortcut, ipcMain } = require('electron');
const path = require('path');
const DirectoryManager = require('./directory-manager.js');

saveFilePaths();

let win;

function saveFilePaths() {
    var problemBuildsDir = "./problem_builds";
    var problemBuildsArg = process.argv.find(arg => arg.startsWith('--problem_builds_dir='));
    
    if (problemBuildsArg && problemBuildsArg.length > 0) {
        problemBuildsDir = problemBuildsArg.split('=')[1];
        console.log("Setting problemBuildsDir to " + problemBuildsDir);
    } else {
        console.log("problemBuildsDir was not set. Using default " + problemBuildsDir);
        console.log("process.argv: " + process.argv);
    }
    problemBuildsDir = path.resolve(problemBuildsDir);
    
    const fs = require('fs');
    fs.writeFileSync(DirectoryManager.getPathsFile(), 
                     problemBuildsDir, 'utf8');
}

function createWindow() {
    win = new BrowserWindow({
            width: 1400,
            height: 1000,
            webPreferences: {
                preload: path.join(__dirname, 'preload.js'),
                nodeIntegration: true,
                contextIsolation: false,
        }
    });

    win.setMenuBarVisibility(false);
    win.loadFile('index.html');

    win.on('closed', () => {
        win = null
    })
}

function registerSaveCommand() {
    const ret = globalShortcut.register('CommandOrControl+S', () => {
        console.log('CommandOrControl+S is pressed')
        win.webContents.send('save-command')
    })
    if (!ret) { console.log('Registration failed!') }
}

function registerRunCommand() {
    const ret = globalShortcut.register('CommandOrControl+R', () => {
        console.log('CommandOrControl+R is pressed')
        win.webContents.send('run-command')
    })
    if (!ret) { console.log('Registration failed!') }
}

function registerCustomTestcaseCommand() {
    const ret = globalShortcut.register('CommandOrControl+T', () => {
        console.log('CommandOrControl+T is pressed')
        win.webContents.send('custom-testcase-command')
    })
    if (!ret) { console.log('Registration failed!') }
}

function registerCommands() {
    registerSaveCommand();
    registerRunCommand();
    registerCustomTestcaseCommand();
}

app.whenReady().then(() => {
    createWindow()
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow()
        }
    })
    registerCommands();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit()
    }
})

app.on('will-quit', () => {
    globalShortcut.unregisterAll()
})

// 커리큘럼 창을 여는 IPC 핸들러 (데이터 전달 기능 추가)
ipcMain.on('open-curriculum-window', (event, conceptsToReview) => {
    const curriculumWin = new BrowserWindow({
        width: 800,
        height: 600,
        title: '학습 커리큘럼',
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });
    curriculumWin.setMenuBarVisibility(false);
    
    // 개념 목록을 JSON 문자열로 변환하여 쿼리 파라미터로 전달
    const query = { concepts: JSON.stringify(conceptsToReview || []) };
    curriculumWin.loadFile('curriculum.html', { query });
});

// 오답 노트 파일 경로를 요청하면 응답해주는 핸들러
ipcMain.handle('get-user-data-path', () => {
    return app.getPath('userData');
});