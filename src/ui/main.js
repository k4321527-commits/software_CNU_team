// main.js

const { app, BrowserWindow, globalShortcut, ipcMain } = require('electron');
const path = require('path');
const DirectoryManager = require('./directory-manager.js');
const dotenv = require('dotenv'); // 환경 변수 로드를 위해 dotenv 사용
const { GoogleGenAI } = require('@google/genai'); // Gemini SDK 사용
const fs = require('fs'); // 파일 시스템 모듈 추가

dotenv.config(); // .env 파일 로드

// Gemini API 클라이언트 초기화
const GEMINI_API_KEY = process.env.GEMINI_API_KEY; 
let ai = null;

if (GEMINI_API_KEY) {
    try {
        // AI 클라이언트 초기화
        ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
        console.log("Gemini AI Client initialized successfully.");
    } catch (e) {
        console.error("Failed to initialize GoogleGenAI:", e);
    }
} else {
    console.warn("GEMINI_API_KEY is missing. AI analysis will be skipped.");
}

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
    
    // 이전에 import 했으므로 const fs = require('fs'); 는 제거
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

// 커리큘럼 창을 여는 IPC 핸들러
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


// [추가] AI 분석 요청 핸들러 (Gemini API 호출)
ipcMain.handle('request-ai-analysis', async (event, analysisData) => {
    if (!ai) {
        throw new Error("AI Client is not initialized. Check GEMINI_API_KEY.");
    }

    const { problemName, code, results } = analysisData;
    
    // --- Gemini 모델을 위한 프롬프트 구성 ---
    const prompt = `
        당신은 코딩 테스트 학습 도우미 AI 'CO-FT'입니다.
        제공된 정보(문제 이름: ${problemName}, 실패 코드, 테스트 결과)를 바탕으로,
        코딩 초보 학습자를 위한 체계적인 3단계 오답 분석 결과를 제공해야 합니다.
        
        응답은 반드시 다음 JSON 형식으로만 해주세요. 내용이 없더라도 구조는 지켜야 합니다.
        {
          "reasonAnalysis": "<h4>1. 오답 원인 분석 💡</h4><p>...</p>",
          "patternAnalysis": "<h4>2. 오답 패턴 기록 🚨</h4><p>...</p>",
          "conceptSummary": "<h4>3. 취약 개념 요약 제시 📚</h4><ul><li>개념 A: 복습 팁</li><li>개념 B: 복습 팁</li></ul>"
        }
        
        <문제 및 실패 정보>
        문제 이름: ${problemName}
        제출 코드:\n${code}
        실패 테스트 결과: ${JSON.stringify(results, null, 2)}
        
        <분석 요구사항>
        1. 오답 원인 분석: 코드가 왜 실패했는지 (논리 오류, 엣지 케이스 처리 실패 등)를 구체적이고 쉽게, 그리고 **존댓말**로 설명.
        2. 오답 패턴 기록: 이 학습자가 흔히 저지르는 실수나 논리적 패턴(예: 배열 인덱스 오류, 반복문 조건 오류, 재귀 탈출 조건 누락 등)을 추측하여 제시.
        3. 취약 개념 요약 제시: 해당 오답을 해결하기 위해 꼭 복습해야 할 핵심 알고리즘 및 자료구조 개념을 3가지 내외로 제시하고, 간단한 복습 팁을 포함. (HTML ul, li 태그 사용)
        
        모든 응답은 HTML 형식으로 포맷팅하여 JSON 필드에 넣어주세요.
    `;

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            config: {
                responseMimeType: "application/json" // JSON 모드 요청
            }
        });

        // JSON 문자열 클리닝 및 파싱
        const jsonText = response.text.trim().replace(/^```json|```$/g, '').trim();
        const analysis = JSON.parse(jsonText);
        return analysis;
        
    } catch (error) {
        console.error('Gemini API 호출 및 분석 실패:', error);
        throw new Error(`AI 분석 실패: ${error.message}`);
    }
});