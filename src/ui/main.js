const { app, BrowserWindow, globalShortcut, ipcMain, shell } = require('electron');
const path = require('path');
const DirectoryManager = require('./directory-manager.js');
const dotenv = require('dotenv');
const { GoogleGenAI } = require('@google/genai');
const fs = require('fs');

dotenv.config();

// =========================================================
// 1. Gemini AI 초기화
// =========================================================
const GEMINI_API_KEY = process.env.GEMINI_API_KEY; 
let ai = null;

if (GEMINI_API_KEY) {
    try {
        ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
        console.log("Gemini AI Client initialized successfully.");
    } catch (e) {
        console.error("Failed to initialize GoogleGenAI:", e);
    }
} else {
    console.warn("GEMINI_API_KEY is missing. AI analysis will be skipped.");
}

// =========================================================
// 2. 기본 설정 및 창 관리
// =========================================================

saveFilePaths();

let win;

function saveFilePaths() {
    var problemBuildsDir = "./problem_builds";
    var problemBuildsArg = process.argv.find(arg => arg.startsWith('--problem_builds_dir='));
    
    if (problemBuildsArg && problemBuildsArg.length > 0) {
        problemBuildsDir = problemBuildsArg.split('=')[1];
    }
    problemBuildsDir = path.resolve(problemBuildsDir);
    fs.writeFileSync(DirectoryManager.getPathsFile(), problemBuildsDir, 'utf8');
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

    // [창 관리] 외부 링크(http) 클릭 시 프로그램 내부 팝업 창(Child Window)으로 열기
    const wc = win.webContents;
    wc.setWindowOpenHandler(({ url }) => {
        if (url.startsWith('http')) {
            const childWin = new BrowserWindow({
                width: 1200,
                height: 900,
                parent: win, 
                modal: false, 
                title: "참고 자료 / 문제 풀이",
                webPreferences: { 
                    nodeIntegration: false, 
                    contextIsolation: true 
                }
            });
            childWin.loadURL(url);
            childWin.setMenuBarVisibility(false);
            return { action: 'deny' }; // 기본 브라우저 팝업 차단하고 위에서 만든 창 띄움
        }
        return { action: 'allow' };
    });
}

// 단축키 등록
function registerSaveCommand() {
    globalShortcut.register('CommandOrControl+S', () => win.webContents.send('save-command'));
}
function registerRunCommand() {
    globalShortcut.register('CommandOrControl+R', () => win.webContents.send('run-command'));
}
function registerCustomTestcaseCommand() {
    globalShortcut.register('CommandOrControl+T', () => win.webContents.send('custom-testcase-command'));
}

app.whenReady().then(() => {
    createWindow();
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
    registerSaveCommand();
    registerRunCommand();
    registerCustomTestcaseCommand();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => globalShortcut.unregisterAll());

// =========================================================
// 4. IPC 핸들러 (AI 기능 구현)
// =========================================================

ipcMain.handle('get-user-data-path', () => app.getPath('userData'));

// [AI: 오답 노트 분석]
ipcMain.handle('request-ai-analysis', async (event, analysisData) => {
    if (!ai) throw new Error("AI Key Missing");
    const { problemName, code, results, historicalPatterns } = analysisData;
    
    const prompt = `
        문제: ${problemName}
        코드:\n${code}
        결과: ${JSON.stringify(results)}
        
        JSON 포맷으로 오답 분석 해줘:
        {
            "reasonAnalysis": "<h4>1. 원인 💡</h4><p>...</p>",
            "patternAnalysis": "<h4>2. 패턴 🚨</h4><p>...</p>",
            "conceptSummary": {
                "title": "<h4>3. 개념 📚</h4>",
                "concepts": [{"name": "개념명", "tip": "팁"}]
            }
        }
        **주의: 뇌 모양 이모지(🧠)는 절대 사용하지 마세요.**
    `;
    const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        config: { responseMimeType: "application/json" }
    });
    return JSON.parse(response.text.replace(/^```json|```$/g, ''));
});

// [AI: 문제 핵심 개념]
ipcMain.handle('request-problem-concepts', async (event, data) => {
    if (!ai) throw new Error("AI Key Missing");
    const prompt = `
        문제: ${data.problemName}
        설명: ${data.description}
        핵심 개념을 HTML(h4, ul, li, p)로 설명해줘.
        아이콘은 💡, 📚, 📌 같은 것만 사용하고 **뇌 모양 이모지는 쓰지 마.**
    `;
    const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [{ role: "user", parts: [{ text: prompt }] }]
    });
    return response.text.trim();
});

// [AI: 관련 문제 추천 (3:1 하이브리드 외부 추천)]
// LeetCode(OpenLeetCode) 3문제 + 백준 1문제
ipcMain.handle('request-related-problems', async (event, data) => {
    if (!ai) throw new Error("AI Key Missing");

    const { problemName } = data;

    const prompt = `
        당신은 코딩 테스트 멘토입니다.
        현재 학습자가 AI 생성 문제 '${problemName}'을(를) 풀고 있습니다.
        
        다음 규칙에 맞춰 총 **4개의 추천 문제**를 선정해주세요:
        
        **[요청 사항]**
        1. **LeetCode(OpenLeetCode) 3개**: 가장 연관성 높은 LeetCode 실제 문제 URL.
        2. **Baekjoon(백준) 1개**: 한국의 백준(BOJ) 사이트에서 가장 유사한 문제 URL.
        
        **응답 형식 (HTML) - 반드시 아래 디자인을 따를 것:**
        
        <h4 style="margin: 15px 0 10px 0; color: #333; font-size:1.1em;">🌐 OpenLeetCode 추천 (LeetCode)</h4>
        <div style="margin-bottom: 15px;">
            <div style="display: flex; align-items: center; gap: 8px;">
                <i class="fas fa-globe" style="color: #007ACC;"></i>
                <a href="LEETCODE_URL" target="_blank" style="font-weight: bold; color: #007ACC; text-decoration: none; font-size:1.05em;">LEETCODE_PROBLEM_TITLE</a>
                <span style="font-size: 0.85em; color: #666;">(Easy/Medium)</span>
            </div>
            <div style="margin-left: 24px; font-size: 0.9em; color: #555; margin-top:4px;">- 추천 이유: ...</div>
        </div>
        <h4 style="margin: 25px 0 10px 0; color: #333; font-size:1.1em;">🏆 실전 연습 (백준)</h4>
        <div style="margin-bottom: 15px;">
            <div style="display: flex; align-items: center; gap: 8px;">
                <i class="fas fa-trophy" style="color: #e67e22;"></i>
                <a href="BOJ_URL" target="_blank" style="font-weight: bold; color: #28a745; text-decoration: none; font-size:1.05em;">백준 문제 제목</a>
                <span style="font-size: 0.85em; color: #666;">(Gold/Silver)</span>
            </div>
            <div style="margin-left: 24px; font-size: 0.9em; color: #555; margin-top:4px;">- 추천 이유: ...</div>
        </div>

        **규칙:**
        1. 실제 접속 가능한 URL이어야 합니다.
        2. **target="_blank"** 속성을 반드시 포함하세요. (새 창 열기)
        3. **뇌 이모지(🧠)는 절대 사용하지 마세요.** 깔끔한 아이콘만 사용하세요.
    `;

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: [{ role: "user", parts: [{ text: prompt }] }]
        });
        return response.text.trim();
    } catch (error) {
        throw new Error(`추천 실패: ${error.message}`);
    }
});

// [AI: CO-FT 문제 생성 (제목 포함)]
ipcMain.handle('generate-co-ft-problem', async (event, difficulty) => {
    if (!ai) throw new Error("AI Key Missing");

    const prompt = `
        C++ 알고리즘 연습 문제 생성. 난이도: ${difficulty}.
        
        응답은 반드시 다음 JSON 포맷:
        {
            "title": "문제 제목 (예: 문자열 뒤집기)",
            "htmlContent": "문제 설명 HTML (h2, p, pre 등 사용)",
            "starterCode": "class Solution { ... }",
            "solutionLogic": "정답 로직 설명"
        }
    `;
    
    const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        config: { responseMimeType: "application/json" }
    });
    
    return JSON.parse(response.text.replace(/^```json|```$/g, ''));
});

// [AI: CO-FT 정답 검증 (isPass 반환, 마크다운 제거, 뇌 아이콘 금지)]
ipcMain.handle('verify-co-ft-solution', async (event, { problem, userCode }) => {
    if (!ai) throw new Error("AI Key Missing");

    const prompt = `
        [문제 정보]
        ${JSON.stringify(problem)}
        
        [사용자 제출 코드]
        ${userCode}
        
        위 코드를 컴파일러처럼 엄격하게 채점해줘.
        
        응답은 반드시 다음 **JSON 포맷**으로만 줘:
        {
            "isPass": true 또는 false, (성공이면 true, 컴파일 에러나 틀리면 false)
            "htmlReport": "채점 결과 HTML 문자열"
        }
        
        [htmlReport 작성 규칙]
        1. <h3>결과: <span style='color: ...'>통과 / 실패 / 컴파일 에러</span></h3>
        2. <h4>🤖 분석</h4>: 시간복잡도, 로직 오류 등 상세 설명
        3. <h4>💡 피드백</h4>: 개선점 제안
        4. 아이콘은 🤖, ✅, ❌ 만 사용 (**뇌 이모지 🧠 금지**)
        5. 마크다운(\`\`\`) 절대 쓰지 말고 순수 HTML만 작성
    `;

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            config: { responseMimeType: "application/json" }
        });

        let result = JSON.parse(response.text);
        
        // 마크다운 태그 2차 세탁
        if (result.htmlReport) {
            result.htmlReport = result.htmlReport.replace(/```html/g, '').replace(/```/g, '').trim();
        }

        return result;

    } catch (e) {
        console.error(e);
        return { 
            isPass: false, 
            htmlReport: `<h3 style="color:red">❌ AI 분석 오류</h3><p>${e.message}</p>` 
        };
    }
});

// [커리큘럼: 목차 생성 (개수 맞춤)]
ipcMain.handle('generate-curriculum', async (event, weakConcepts) => {
    if (!ai) throw new Error("AI Key Missing");

    // 취약점이 없으면 빈 배열
    if (!weakConcepts || weakConcepts.length === 0) {
        return [];
    }

    const conceptsStr = weakConcepts.join(', ');
    const count = weakConcepts.length; // 취약점 개수
    
    const prompt = `
        학습자의 취약점 ${count}개: [${conceptsStr}]
        
        이 약점을 보완할 **정확히 ${count}단계**의 학습 커리큘럼을 짜줘.
        
        응답은 반드시 아래 JSON 배열 형식 (항목 ${count}개):
        [
            {"topic": "주제명", "desc": "간단 설명"},
            ...
        ]
    `;

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            config: { responseMimeType: "application/json" }
        });
        return JSON.parse(response.text.replace(/^```json|```$/g, ''));
    } catch (e) {
        return [];
    }
});

// [커리큘럼 학습 컨텐츠 추천]
ipcMain.handle('request-learning-content', async (event, { topic, type }) => {
    if (!ai) throw new Error("AI Key Missing");

    let prompt = "";

    if (type === 'video') {
        prompt = `
            학습 주제: '${topic}'
            초보자를 위한 YouTube 영상 검색어 3가지를 추천해줘.
            
            응답 HTML:
            <h3>📺 '${topic}' 추천 영상</h3>
            <ul>
                <li>
                    <strong>1. [검색어]</strong><br>
                    <a href="https://www.youtube.com/results?search_query=${encodeURIComponent(topic + ' 강의')}" target="_blank" style="color:#ff0000; text-decoration:none;">▶ 유튜브 검색 결과 보러가기</a>
                </li>
            </ul>
        `;
    } else {
        prompt = `
            학습 주제: '${topic}'
            연습하기 좋은 **백준(BOJ)** 또는 **LeetCode** 문제 3개를 추천해줘.
            
            응답 HTML:
            <h3>📝 '${topic}' 실전 문제</h3>
            <ul>
                <li>
                    <strong>1. 문제명 (사이트)</strong><br>
                    - 링크: <a href="문제URL" target="_blank" style="color:#007ACC; font-weight:bold;">문제 바로가기</a>
                </li>
            </ul>
        `;
    }

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: [{ role: "user", parts: [{ text: prompt }] }]
        });
        return response.text;
    } catch (e) {
        return `<p>오류 발생: ${e.message}</p>`;
    }
});

// [신규] 정답 코드 생성 핸들러 (오답 노트용)
ipcMain.handle('request-solution-code', async (event, problem) => {
    if (!ai) throw new Error("AI Key Missing");

    const prompt = `
        다음 문제에 대한 **최적화된 C++ 정답 코드**를 작성해줘.
        
        [문제 정보]
        ${JSON.stringify(problem)}
        
        **요청 사항:**
        1. 주석으로 코드의 핵심 로직을 간단히 설명해줘.
        2. 시간 복잡도와 공간 복잡도를 코드 맨 아래에 주석으로 달아줘.
        3. 오직 코드만 출력해 (마크다운 \`\`\` 없이).
        4. 뇌 이모지 금지.
    `;

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: [{ role: "user", parts: [{ text: prompt }] }]
        });
        // 마크다운 제거 후 반환
        return response.text.replace(/```cpp/g, '').replace(/```/g, '').trim();
    } catch (e) {
        return `// 정답 생성 실패: ${e.message}`;
    }
});

// [커리큘럼 창 열기]
ipcMain.on('open-curriculum-window', (event, conceptsToReview) => {
    const curriculumWin = new BrowserWindow({
        width: 1300,
        height: 800,
        title: '학습 커리큘럼',
        webPreferences: {
            nodeIntegration: true, 
            contextIsolation: false
        }
    });
    curriculumWin.setMenuBarVisibility(false);
    
    // 외부 링크는 내부 팝업으로
    curriculumWin.webContents.setWindowOpenHandler(({ url }) => {
        if (url.startsWith('http')) {
            const childWin = new BrowserWindow({
                width: 1200, height: 900, parent: curriculumWin, modal: false,
                title: "학습 자료",
                webPreferences: { nodeIntegration: false, contextIsolation: true }
            });
            childWin.loadURL(url);
            childWin.setMenuBarVisibility(false);
            return { action: 'deny' };
        }
        return { action: 'allow' };
    });
    
    const query = { concepts: JSON.stringify(conceptsToReview || []) };
    curriculumWin.loadFile('curriculum.html', { query });
});

