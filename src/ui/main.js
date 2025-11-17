// [수정] shell 모듈을 electron에서 함께 가져옵니다.
const { app, BrowserWindow, globalShortcut, ipcMain, shell } = require('electron');
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
    });

    // --- [!!! 여기가 핵심입니다 !!!] ---
    // [수정] 링크 문제 해결을 위한 코드
    const wc = win.webContents;

    // 1. target="_blank" (새 창) 링크 처리
    wc.setWindowOpenHandler(({ url }) => {
        if (url.startsWith('http')) {
            console.log('Opening new window (setWindowOpenHandler):', url);
            shell.openExternal(url); // 시스템 기본 브라우저로 열기
            return { action: 'deny' }; // Electron 앱 내에서는 새 창 띄우기 금지
        }
        return { action: 'allow' };
    });

    // 2. target이 없는 (같은 창) 링크 처리
    wc.on('will-navigate', (event, url) => {
        // "http"로 시작하는 링크(즉, 외부 웹사이트)로 이동하려고 하면
        if (url.startsWith('http')) {
            console.log('Opening link in same window (will-navigate):', url);
            // 1. Electron 내부의 네비게이션을 막습니다.
            event.preventDefault();
            // 2. shell을 사용해 사용자의 기본 브라우저에서 엽니다.
            shell.openExternal(url);
        }
        // (http가 아닌 file:// 등 내부 이동은 그대로 둡니다)
    });
    // --- 링크 문제 해결 코드 끝 ---
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
    
    const query = { concepts: JSON.stringify(conceptsToReview || []) };
    curriculumWin.loadFile('curriculum.html', { query });
});

// 오답 노트 파일 경로를 요청하면 응답해주는 핸들러
ipcMain.handle('get-user-data-path', () => {
    return app.getPath('userData');
});


// AI 분석 요청 핸들러
ipcMain.handle('request-ai-analysis', async (event, analysisData) => {
    if (!ai) {
        throw new Error("AI Client is not initialized. Check GEMINI_API_KEY.");
    }

    const { problemName, code, results, historicalPatterns } = analysisData;
    const pastPatterns = historicalPatterns || []; 

    const prompt = `
        당신은 코딩 테스트 학습 도우미 AI 'CO-FT'입니다.
        제공된 정보(문제 이름, 실패 코드, 테스트 결과, **과거 오답 패턴 목록**)를 바탕으로,
        코딩 초보 학습자를 위한 체계적인 3단계 오답 분석 결과를 제공해야 합니다.
        
        응답은 반드시 다음 JSON 형식으로만 해주세요. 내용이 없더라도 구조는 지켜야 합니다.

        {
            "reasonAnalysis": "<h4>1. 오답 원인 분석 💡</h4><p>...</p>",
            "patternAnalysis": "<h4>2. 오답 패턴 기록 🚨</h4><p>...</p>",
            "conceptSummary": {
                "title": "<h4>3. 취약 개념 요약 제시 📚</h4>",
                "concepts": [
                    {"name": "이진 트리 순회", "tip": "너비 우선 탐색(BFS)은..."},
                    {"name": "완전 이진 트리의 정의", "tip": "마지막 레벨을 제외한..."},
                    {"name": "큐(Queue) 자료구조", "tip": "BFS를 구현할 때 필수적인..."}
                ]
            }
        }
        
        <문제 및 실패 정보>
        문제 이름: ${problemName}
        제출 코드:\n${code}
        실패 테스트 결과: ${JSON.stringify(results, null, 2)}
        과거 오답 패턴 목록: ${JSON.stringify(pastPatterns)} 
        
        <분석 요구사항>
        1. 오답 원인 분석 (reasonAnalysis): 
            - 코드가 왜 실패했는지 (논리 오류, 엣지 케이스 처리 실패 등)를 구체적이고 쉽게, 그리고 **존댓말**로 설명.
        
        2. 취약 개념 요약 제시 (conceptSummary): 
            - '1. 오답 원인 분석'과 연관되어, 해당 오답을 해결하기 위해 꼭 복습해야 할 핵심 알고리즘 및 자료구조 개념을 **JSON "concepts" 배열**로 제시.
            - "name" 필드: 취약 개념의 이름 (예: "이진 트리 순회 (Binary Tree Traversal)")
            - "tip" 필드: 간단한 복습 팁 (예: "너비 우선 탐색(BFS)은...")
            - **이 "concepts" 배열은 '나의 취약개념' 탭에서 누적 집계되므로, "name"을 일관성 있게 작성하는 것이 매우 중요합니다.** (예: '큐' vs 'Queue' -> '큐(Queue) 자료구조'로 통일)

        3. 오답 패턴 기록 (patternAnalysis):
            - **'과거 오답 패턴 목록'**과 **'현재 제출 코드'**를 함께 분석.
            - 현재 코드의 실수 유형을 **간단한 키워드**로 식별 (예: '문법 오류', '변수 사용 오류', '클래스 이해 부족', '인덱스 범위 초과' 등).
            - 이 키워드가 과거 패턴 목록에 얼마나 자주 등장하는지 요약.
        
        reasonAnalysis, patternAnalysis, conceptSummary.title 필드는 HTML 형식으로 포맷팅하여 JSON 필드에 넣어주세요.
    `;

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            config: {
                responseMimeType: "application/json" // JSON 모드 요청
            }
        });

        const jsonText = response.text.trim().replace(/^```json|```$/g, '').trim();
        const analysis = JSON.parse(jsonText);
        return analysis;
        
    } catch (error) {
        console.error('Gemini API 호출 및 분석 실패:', error);
        throw new Error(`AI 분석 실패: ${error.message}`);
    }
});

// 문제 핵심 개념 분석 핸들러
ipcMain.handle('request-problem-concepts', async (event, data) => {
    if (!ai) {
        throw new Error("AI Client is not initialized. Check GEMINI_API_KEY.");
    }

    const { problemName, description } = data;

    const prompt = `
        당신은 코딩 테스트 학습 도우미 AI 'CO-FT'입니다.
        현재 학습자가 '${problemName}' 문제를 보고 있습니다.

        <문제 설명>
        ${description}
        </<문제 설명>

        이 문제를 풀기 위해 반드시 알아야 할 **핵심 알고리즘 및 자료구조 개념**들을 설명해주세요.
        코딩 초보자도 이해할 수 있도록 쉬운 말로, 존댓말로 설명해야 합니다.

        응답은 다음 요구사항을 포함한 **HTML 문자열** 형식으로만 해주세요.

        1.  <h4>${problemName} 문제의 핵심 개념 💡</h4>
        2.  <p>이 문제를 해결하기 위해 필요한 핵심 개념은 다음과 같습니다.</p>
        3.  <ul>
                <li><strong>핵심 개념 1 (예: 해시 맵):</strong> 왜 이 개념이 필요한지, 어떻게 활용되는지 1-2 문장으로 설명.</li>
                <li><strong>핵심 개념 2 (예: 반복문):</strong> 왜 이 개념이 필요한지, 어떻게 활용되는지 1-2 문장으로 설명.
            </ul>
        4.  <p>이 개념들을 복습하시면 문제 해결에 큰 도움이 될 것입니다.</p>
    `;

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: [{ role: "user", parts: [{ text: prompt }] }]
        });

        const htmlResponse = response.text.trim();
        return htmlResponse;

    } catch (error) {
        console.error('Gemini API (concepts) 호출 실패:', error);
        throw new Error(`AI 개념 분석 실패: ${error.message}`);
    }
});

// 관련 문제 추천 핸들러
ipcMain.handle('request-related-problems', async (event, data) => {
    if (!ai) {
        throw new Error("AI Client is not initialized. Check GEMINI_API_KEY.");
    }

    const { problemName } = data;

    const prompt = `
        당신은 코딩 테스트 학습 도우미 AI 'CO-FT'입니다.
        현재 학습자가 '${problemName}' 문제를 풀고 있습니다.
        이 문제와 **개념적으로 연관성이 높으면서, 난이도는 더 쉬운** 연습 문제 3가지를 추천해주세요.

        응답은 다음 요구사항을 포함한 **HTML 문자열** 형식으로만 해주세요.
        - LeetCode, 백준 등 실제 존재하는 문제면 좋습니다.
        - 왜 이 문제를 추천하는지 간단한 이유를 포함해주세요.
        - (중요) 3단계 풀이 기능을 위해, 각 문제 항목은 <li> 태그로 감싸주세요.
        
        - [중요!] 문제 제목(예: "LeetCode 102...")은 반드시 <a> 태그로 감싸고,
        - 실제 해당 문제 페이지로 연결되는 href 속성 (예: "https://leetcode.com/problems/...")을 포함해야 합니다.
        - 또한, <a> 태그에 target="_blank" 속성을 추가해주세요.

        <예시 응답 형식>
        <h4>'${problemName}' 관련 기초 문제 🚀</h4>
        <p>이 문제와 관련된 기초 개념을 다질 수 있는 문제들입니다.</p>
        <ul>
            <li>
                <strong>문제 1 <a href="https://leetcode.com/problems/two-sum/" target="_blank">(LeetCode 1. Two Sum)</a>:</strong>
                (이유) 이 문제는 ... 개념을 연습하기 좋습니다.
            </li>
            <li>
                <strong>문제 2 <a href="https://www.acmicpc.net/problem/10828" target="_blank">(백준 10828. 스택)</a>:</strong>
                (이유) ...
            </li>
        </ul>
    `;

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: [{ role: "user", parts: [{ text: prompt }] }]
        });

        const htmlResponse = response.text.trim();
        return htmlResponse;

    } catch (error) {
        console.error('Gemini API (related problems) 호출 실패:', error);
        throw new Error(`AI 관련 문제 추천 실패: ${error.message}`);
    }
});