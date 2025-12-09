const path = require('path');
const file = require('fs');
const amdLoader = require('monaco-editor/min/vs/loader.js');
const Split = require('split.js');
const { ipcRenderer, shell } = require('electron');
const { exec } = require('child_process');
const DirectoryManager = require('./directory-manager.js');
const { Validator } = require('jsonschema');
const createNoteManager = require('./note-manager.js');
const translateError = require('./error-translator.js');

const amdRequire = amdLoader.require;
const amdDefine = amdLoader.require.define;
var editor;

const directory_manager = require('./directory-manager.js');
const directoryManager = new directory_manager.DirectoryManager();
var noteManager = null;
var problemBuildsDir;

amdRequire.config({
    baseUrl: path.join(__dirname, './node_modules/monaco-editor/min')
});

var activeProblem = null;
var previousProblem;
let currentGeneratedProblem = null; 

self.module = undefined;

// =========================================================
// 1. 파일 시스템 및 기본 로직
// =========================================================

function saveSolution(language, content) {
    if (!previousProblem) return;
    if (previousProblem === "CO-FT PROBLEM" || previousProblem.startsWith("CO-FT-")) return;

    const userSolutionFilename = directoryManager.getUserSolutionFilename(previousProblem);
    if (file.existsSync(userSolutionFilename) &&
        file.readFileSync(userSolutionFilename, 'utf8') === content) {
        return;
    }
    file.writeFileSync(userSolutionFilename, content);
}

function parseResultsFileFromStdout(stdout) {
    match = stdout.match(/Results written to (.*\.results)/);
    if (!match || match.length === 0) return null;
    return match[1];
}

function parseBuildError(stdout) {
    const regex = /cmake --build[\s\S]*?cmake --build/;
    const match = stdout.match(regex);
    if (!match || match.length === 0) return stdout;
    return match[0].split('\n').slice(1, -1).join('\n');
}

function validateResults(results) {
    try {
        const schema = directoryManager.getResultsSchemaJson();
        if (schema.hasOwnProperty('$id')) delete schema['$id'];
        
        const v = new Validator();
        const validation = v.validate(results, schema);
        if (!validation.valid) {
            console.error("Validation errors:", validation.errors);
            return false;
        }
    } catch (e) {
        console.error("Error validating data:", e);
        return false;
    }
    return true;
}

function readTestcaseFile(filename) {
    if (filename == undefined) return "Testcase file not defined";
    try {
        var testcaseFileContent = file.readFileSync(filename, "utf8");
        return testcaseFileContent.replace(/\n/g, "<br>&emsp;");
    } catch (err) {
        return `Error reading file ${filename}: ${err}`;
    }
}

// =========================================================
// 2. 테스트 결과 및 실행 로직
// =========================================================

function setTestResults(results) {
    if (!validateResults(results)) return;
    
    const div = document.getElementById('test-results-content');
    let html = `
        <p>Duration: ${results.duration_ms} ms</p>
        <p>Status: ${results.status}</p>
        <p>Testcase Filter: ${results.testcase_filter_name}</p>
        <hr>
    `;

    html += results.tests.map(test => {
        var testcase;
        if (test.testcase_file !== undefined) {
            testcase = readTestcaseFile(test.testcase_file);
        }

        if (test.status !== 'Pass') {
            // 로컬 문제인 경우에만 실패 파일 저장
            if (!activeProblem.startsWith("CO-FT-")) {
                const failedTestcasePath = path.join(
                    problemBuildsDir, "problems", activeProblem, `${test.testcase_name}_failed.txt`
                );
                try {
                    let fileContent = `Testcase: ${test.testcase_name}\n`;
                    fileContent += `Status: ${test.status}\n`;
                    if (test.actual) fileContent += `Actual: ${JSON.stringify(test.actual)}\n`;
                    if (test.expected) fileContent += `Expected: ${JSON.stringify(test.expected)}\n`;
                    if (testcase) fileContent += `Testcase Content: ${testcase.replace(/<br>&emsp;/g, "\n")}\n`;

                    if(file.existsSync(path.dirname(failedTestcasePath))) {
                        file.writeFileSync(failedTestcasePath, fileContent);
                    }
                } catch(e) { console.log("Failed to write failed testcase info", e); }
            }
        }

        return `
            <p>${testcase ? '실패한 ' : ''}Testcase Name: ${test.testcase_name}</p>
            <p>Status: ${test.status}</p>
            ${test.actual ? `<p>Actual: ${JSON.stringify(test.actual)}</p>` : ''}
            ${test.expected ? `<p>정답값: ${JSON.stringify(test.expected)}</p>` : ''}
            ${test.reason ? `<p>틀린이유: ${test.reason}</p>` : ''}
            ${testcase ? `<p>반례: ${testcase}</p>` : ''}
            <hr>
        `;
    }).join('');

    div.innerHTML = html;
    document.getElementById('tab-test-results-button').click();

    // [로컬 문제] 실패 시 오답 노트 자동 저장
    const passStatuses = ['Pass', 'Passed', 'Success', 'Ok', 'OK'];
    const allTestsPassed = results.tests.every(test => passStatuses.includes(test.status));

    if (!allTestsPassed) {
        if (noteManager) {
            console.log("Local Problem Failed. Saving Note...");
            noteManager.addNote(activeProblem, editor.getValue(), results);
            setNotes(activeProblem);     // 오답노트 탭 갱신
            setMyWeakConcepts();         // 취약개념 탭 갱신
        }
    }
}

function run(callback, testcase = 'All', expected = false) {
    // CO-FT 문제는 로컬 컴파일러로 실행 불가 -> AI 검증 유도
    if (activeProblem.startsWith("CO-FT-") || activeProblem === "CO-FT PROBLEM") {
        alert("AI 생성 문제는 'AI 검증' 버튼을 이용해주세요.");
        return;
    }

    saveSolution('cpp', editor.getValue());
    const pathsFile = DirectoryManager.getPathsFile();
    if (!file.existsSync(pathsFile)) throw new Error(`Paths file does not exist: ${pathsFile}`);

    problemBuildsDir = file.readFileSync(pathsFile, 'utf8');
    problemBuildsDir = path.resolve(problemBuildsDir);

    const extension = process.platform === 'win32' ? '.bat' : '.sh';
    const command = `${problemBuildsDir}/openleetcode${extension} ` +
        `--problem_builds_dir ${problemBuildsDir} ` +
        `--language cpp ` +
        `--problem ${activeProblem} ` +
        `--testcase ${testcase} ` +
        `${expected ? '--run-expected-tests ' : ''}` +
        `--verbose`;
    
    exec(command, (error, stdout, stderr) => {
        var element = document.getElementById("compilation-content");
        element.innerHTML = "";
        
        var resultsFilename = parseResultsFileFromStdout(stdout);
        if (!resultsFilename || !file.existsSync(resultsFilename)) {
            const parsedError = parseBuildError(stdout || stderr);
            element.innerHTML = translateError(parsedError);
            document.getElementById('tab-compilation-button').click();
            
            // [로컬 문제] 컴파일/빌드 에러 시 오답 노트 저장
            if (noteManager) {
                const compileErrorResult = {
                    status: "Compilation Error",
                    tests: [{
                        status: "Failed",
                        testcase_name: "Build/Compile",
                        reason: "컴파일 또는 빌드 오류",
                        actual: parsedError
                    }]
                };
                noteManager.addNote(activeProblem, editor.getValue(), compileErrorResult);
                setNotes(activeProblem);
                setMyWeakConcepts();
            }
            return;
        }

        const results = file.readFileSync(resultsFilename, 'utf8');
        const resultsJson = JSON.parse(results);
        
        if (resultsJson.errorcode && resultsJson.errorcode !== 0) {
            let html = `<p>Errorcode: ${resultsJson.errorcode}</p><p>Stdout: ${resultsJson.stdout}</p><p>Stderr: ${resultsJson.stderr}</p>`;
            element.innerHTML = html;
            document.getElementById('tab-compilation-button').click();

            // [로컬 문제] 런타임 에러 시 오답 노트 저장
            if (noteManager) {
                const runtimeErrorResult = {
                    status: "Runtime Error",
                    tests: [{
                        status: "Failed",
                        testcase_name: "Runtime",
                        reason: `실행 오류 (Code: ${resultsJson.errorcode})`,
                        actual: resultsJson.stderr
                    }]
                };
                noteManager.addNote(activeProblem, editor.getValue(), runtimeErrorResult);
                setNotes(activeProblem);
                setMyWeakConcepts();
            }
        } else {
            callback(resultsJson);
        }
    });
}

function setCustomTestcaseResults(results) {
    if (!validateResults(results)) return;
    document.getElementById('testcase-stderr').textContent = results.stderr;
    document.getElementById('testcase-stdout').textContent = results.stdout;
    document.getElementById('testcase-output').textContent = JSON.stringify(results.tests[0].actual);
    
    run(setExpectedTestcaseResults, directoryManager.getCustomTestcaseName(), true);
    document.getElementById('tab-testcases').click();
}

function setExpectedTestcaseResults(expected) {
    if (!validateResults(expected)) return;
    document.getElementById('expected-output').textContent = JSON.stringify(expected.tests[0].actual);
}

function runCustomTestcase() {
    if (activeProblem.startsWith("CO-FT")) {
        alert("AI 생성 문제는 커스텀 테스트케이스 기능을 지원하지 않습니다.");
        return;
    }
    document.getElementById('testcase-stdout').textContent = "";
    document.getElementById('testcase-stderr').textContent = "";
    document.getElementById('testcase-output').textContent = "";
    document.getElementById('compilation-content').innerHTML = "";
    document.getElementById('test-results-content').innerHTML = "";
    
    const input = document.getElementById('input-container').value + "\n*";
    const customTestcaseFilename = directoryManager.getCustomTestcaseFilename(activeProblem);
    
    if (!file.existsSync(path.dirname(customTestcaseFilename))) return;
    
    file.writeFileSync(customTestcaseFilename, input);
    run(setCustomTestcaseResults, directoryManager.getCustomTestcaseName());
}

// =========================================================
// 3. UI 컨텐츠 업데이트
// =========================================================

function setDescription(problemName) {
    document.querySelector('.markdown-content#description-content').innerHTML = directoryManager.getDescription(problemName);
}

function setSolution(problemName) {
    document.querySelector('.markdown-content#solution-content').innerHTML = directoryManager.getSolution(problemName);
}

function setUserSolution(problemName) {
    const filename = directoryManager.getUserSolutionFilename(problemName);
    editor.setValue(file.readFileSync(filename, 'utf8'));
}

function loadCoFtTabContent(tabName) {
    if (!currentGeneratedProblem) return;

    const containerMap = {
        'Solution': 'solution-content',
        '개념': 'concept-content',
        '선행 문제': 'related-problems-content'
    };
    const containerId = containerMap[tabName];
    if (!containerId) return;

    const container = document.getElementById(containerId);

    if (!currentGeneratedProblem.cachedTabs) {
        currentGeneratedProblem.cachedTabs = {};
    }
    if (currentGeneratedProblem.cachedTabs[tabName]) {
        if (container.innerHTML !== currentGeneratedProblem.cachedTabs[tabName]) {
            container.innerHTML = currentGeneratedProblem.cachedTabs[tabName];
            if (tabName === '선행 문제') bindRelatedProblemButton(container);
        }
        return; 
    }

    if (tabName === 'Solution') {
        const html = `
            <div style="padding:15px;">
                <h2 style="border-bottom:1px solid #eee; padding-bottom:10px;">${currentGeneratedProblem.title} - Solution Guide</h2>
                <div style="background:#f6f8fa; padding:15px; border-radius:5px; border:1px solid #e1e4e8; line-height:1.6;">
                    ${currentGeneratedProblem.solutionLogic || "풀이 로직이 제공되지 않았습니다."}
                </div>
            </div>`;
        currentGeneratedProblem.cachedTabs['Solution'] = html;
        container.innerHTML = html;

    } else if (tabName === '개념') {
        container.innerHTML = `<div style="text-align:center; padding:20px;">⌛ AI가 핵심 개념을 분석 중입니다...</div>`;
        ipcRenderer.invoke('request-problem-concepts', {
            problemName: currentGeneratedProblem.title,
            description: currentGeneratedProblem.htmlContent
        }).then(html => {
            currentGeneratedProblem.cachedTabs['개념'] = html;
            container.innerHTML = html;
        }).catch(e => container.innerHTML = `<p style="color:red">오류: ${e.message}</p>`);

    } else if (tabName === '선행 문제') {
        container.innerHTML = `
            <div style="padding: 30px 20px; text-align: center;">
                <p style="margin-bottom: 20px; color: #555; font-size: 1.1em; line-height: 1.6;">
                    이 문제와 관련된<br>
                    <strong>OpenLeetCode 문제(3개)</strong>와 <strong>백준 문제(1개)</strong>를<br>
                    함께 추천받아 완벽하게 학습하세요!
                </p>
                <button id="coft-recommend-btn" class="recommend-btn">
                    🚀 맞춤 문제 추천받기
                </button>
                <div id="coft-recommend-loading" style="display:none; margin-top:20px; color:#007ACC; font-weight:bold;">
                    내 문제 목록과 백준을 분석 중입니다... ⏳
                </div>
            </div>
        `;
        bindRelatedProblemButton(container);
    }
}

function bindRelatedProblemButton(container) {
    const btn = container.querySelector('#coft-recommend-btn');
    const loading = container.querySelector('#coft-recommend-loading');

    if (btn) {
        btn.addEventListener('click', () => {
            btn.style.display = 'none';
            loading.style.display = 'block';

            ipcRenderer.invoke('request-related-problems', {
                problemName: currentGeneratedProblem.title
            }).then(html => {
                currentGeneratedProblem.cachedTabs['선행 문제'] = html;
                container.innerHTML = html;
            }).catch(e => {
                container.innerHTML = `<p style="color:red">오류: ${e.message}</p>`;
            });
        });
    }
}

function setConcepts(problemName) {
    const content = document.getElementById('concept-content');
    content.innerHTML = `
        <div class="note-content">
            <p>현재 문제(${problemName})의 핵심 개념을 AI에게 물어볼 수 있습니다.</p>
            <button id="get-concepts-btn" class="ai-analysis-btn">💡 AI 핵심 개념 분석</button>
            <div id="ai-concepts-result"></div>
        </div>
    `;
    document.getElementById('get-concepts-btn').addEventListener('click', async () => {
        const btn = document.getElementById('get-concepts-btn');
        const res = document.getElementById('ai-concepts-result');
        btn.disabled = true; btn.textContent = "분석 중...";
        try {
            const html = await ipcRenderer.invoke('request-problem-concepts', {
                problemName: activeProblem, description: directoryManager.getDescription(activeProblem)
            });
            res.innerHTML = html;
        } catch (e) { res.innerHTML = "Error: " + e.message; }
        finally { btn.disabled = false; btn.textContent = "💡 AI 핵심 개념 분석"; }
    });
}

function setRelatedProblems(problemName) {
    const content = document.getElementById('related-problems-content');
    content.innerHTML = `
        <div class="note-content">
            <p>관련된 쉬운 문제 추천받기</p>
            <button id="get-related-problems-btn" class="ai-analysis-btn">🚀 추천받기</button>
            <div id="related-problems-container"></div>
        </div>
    `;
    document.getElementById('get-related-problems-btn').addEventListener('click', async () => {
        const btn = document.getElementById('get-related-problems-btn');
        const con = document.getElementById('related-problems-container');
        btn.disabled = true; btn.textContent = "추천 중...";
        try {
            const html = await ipcRenderer.invoke('request-related-problems', { problemName: activeProblem });
            con.innerHTML = html;
        } catch (e) { con.innerHTML = "Error: " + e.message; }
        finally { btn.disabled = false; btn.textContent = "🚀 추천받기"; }
    });
}

// =========================================================
// 4. 오답 노트 및 취약 개념
// =========================================================

function setNotes(problemName) {
    const content = document.getElementById('notes-content');
    if (!noteManager) { content.innerHTML = "<p>로딩 중...</p>"; return; }
    
    const notes = noteManager.getNotes(problemName);
    if (notes.length === 0) {
        content.innerHTML = "<p>아직 이 문제에 대한 오답 기록이 없습니다.</p>";
        return;
    }
    
    content.innerHTML = notes.map(note => {
        const failedTest = note.results.tests.find(t => t.status !== 'Pass') || { testcase_name: "저장" };
        const testName = failedTest.testcase_name;
        
        const aiData = note.aiAnalysis;
        let aiHtml = '';

        if (aiData) {
            let conceptHtml = '';
            if (aiData.conceptSummary?.concepts) {
                conceptHtml = '<ul>' + aiData.conceptSummary.concepts.map(c => `<li><strong>${c.name}:</strong> ${c.tip}</li>`).join('') + '</ul>';
            }
            aiHtml = `
                <h4>🌟 AI 오답 분석 결과</h4>
                ${aiData.reasonAnalysis || ''} 
                ${aiData.patternAnalysis || ''} 
                ${conceptHtml} 
            `;
        } else {
            aiHtml = `<button class="ai-analysis-btn" data-timestamp="${note.timestamp}">🔍 AI 분석 요청</button>`;
        }

        return `
            <div class="note-item">
                <details ${aiData ? 'open' : ''}>
                    <summary class="note-summary">
                        ${new Date(note.timestamp).toLocaleString()} - <span class="note-status-fail">오답</span>
                        <span class="delete-note-btn delete-btn" data-timestamp="${note.timestamp}" title="삭제">❌</span>
                    </summary>
                    <div class="note-content">
                        <h4>실패한 케이스: ${testName}</h4>
                        <hr>
                        ${aiHtml}
                        <hr>
                        <h4>제출 코드</h4>
                        <pre><code class="language-cpp">${note.code.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</code></pre>
                    </div>
                </details>
            </div>
        `;
    }).join('');

    if (window.hljs) {
        document.querySelectorAll('#notes-content pre code').forEach((el) => {
            window.hljs.highlightElement(el);
        });
    }
}

// [신규] 정답 코드 생성 버튼 이벤트
function initializeSolutionGenerator() {
    const btn = document.getElementById('generate-solution-btn');
    const area = document.getElementById('solution-code-area');
    const codeBlock = document.getElementById('ai-solution-code');

    if (!btn) return;

    btn.addEventListener('click', async () => {
        if (!activeProblem) {
            alert("먼저 문제를 선택해주세요.");
            return;
        }

        btn.disabled = true;
        btn.textContent = "AI가 최적의 코드를 작성 중입니다... ⏳";
        area.style.display = 'none';

        try {
            let problemData = activeProblem.startsWith("CO-FT") 
                ? currentGeneratedProblem 
                : { title: activeProblem, description: directoryManager.getDescription(activeProblem) };

            const solutionCode = await ipcRenderer.invoke('request-solution-code', problemData);

            codeBlock.textContent = solutionCode;
            area.style.display = 'block';
            
            if (window.hljs) window.hljs.highlightElement(codeBlock);

        } catch (e) {
            alert("생성 실패: " + e.message);
        } finally {
            btn.disabled = false;
            btn.textContent = "✨ AI 정답 코드 생성하기";
        }
    });
}

function setMyWeakConcepts() {
    const content = document.getElementById('weak-concepts-summary-content');
    if (!noteManager) { content.innerHTML = "<p>로딩 중...</p>"; return; }

    const allNotes = noteManager.getAllNotes();
    const ignoredList = noteManager.getIgnoredConcepts(); 
    const conceptMap = new Map();

    const existingGeneratedProblems = noteManager.getGeneratedProblems().map(p => p.id);

    allNotes.forEach(note => {
        if (note.problemName.startsWith("CO-FT-") && !existingGeneratedProblems.includes(note.problemName)) {
            return;
        }

        if (note.aiAnalysis?.conceptSummary?.concepts) {
            note.aiAnalysis.conceptSummary.concepts.forEach(concept => {
                const name = concept.name.split('(')[0].trim();
                if (ignoredList.includes(name)) return; 

                const entry = conceptMap.get(name) || { count: 0, tips: [] };
                entry.count++;
                if (!entry.tips.includes(concept.tip)) entry.tips.push(concept.tip);
                conceptMap.set(name, entry);
            });
        }
    });

    if (conceptMap.size === 0) {
        content.innerHTML = `<div class="weak-concept-summary"><p>표시할 취약 개념이 없습니다.</p></div>`;
        return;
    }

    const sortedConcepts = Array.from(conceptMap.entries()).sort((a, b) => b[1].count - a[1].count);

    let html = `<div class="weak-concept-summary"><p>나의 주요 취약 개념 (누적)</p><ul class="weak-concept-list">`;

    sortedConcepts.forEach(([name, entry]) => {
        html += `
            <li>
                <details class="weak-concept-details">
                    <summary> 
                        <span class="weak-concept-name">${name}</span>
                        <div style="display: flex; align-items: center;">
                            <span class="weak-concept-count">${entry.count}회</span>
                            <span class="delete-concept-btn" data-name="${name}" title="이 개념 목록에서 삭제">✕</span>
                        </div>
                    </summary>
                    <div class="weak-concept-content"> ${entry.tips.map(tip => `<p>• ${tip}</p>`).join('')}
                    </div>
                </details>
            </li>`;
    });
    html += '</ul></div>';
    content.innerHTML = html;

    document.querySelectorAll('.delete-concept-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation(); e.preventDefault();
            const conceptName = e.target.dataset.name;
            if (confirm(`'${conceptName}' 개념을 목록에서 지우시겠습니까?`)) {
                noteManager.ignoreConcept(conceptName);
                setMyWeakConcepts();
            }
        });
    });
}

// =========================================================
// 5. 문제 선택 및 모드 전환
// =========================================================

function onProblemSelected(problemName) {
    document.getElementById('testcase-stdout').textContent = "";
    document.getElementById('testcase-stderr').textContent = "";
    document.getElementById('testcase-output').textContent = "";
    
    const runBtn = document.getElementById('run-button');
    const verifyBtn = document.getElementById('verify-button');
    const testcaseBtn = document.getElementById('custom-testcase-button');
    const descContent = document.getElementById('description-content');
    const generatorUI = document.getElementById('co-ft-generator-ui');

    if (problemName === "CO-FT PROBLEM") {
        descContent.style.display = 'none';
        generatorUI.style.display = 'block';
        runBtn.style.display = 'none';
        testcaseBtn.style.display = 'none';
        verifyBtn.style.display = 'inline-block';

        const descTab = document.getElementById('tab-label-description');
        if (descTab) descTab.click();
        
        renderGeneratedProblemsList();

        if (!currentGeneratedProblem) {
            editor.setValue("// '문제 생성하기' 버튼을 눌러 문제를 받아보세요.");
            activeProblem = "CO-FT PROBLEM";
        } else {
            activeProblem = currentGeneratedProblem.id;
        }

    } else {
        if (previousProblem && !previousProblem.startsWith("CO-FT")) {
            saveSolution('cpp', editor.getValue());
        }

        descContent.style.display = 'block';
        generatorUI.style.display = 'none';
        runBtn.style.display = 'inline-block';
        testcaseBtn.style.display = 'inline-block';
        verifyBtn.style.display = 'none';

        setDescription(problemName);
        setSolution(problemName);
        setUserSolution(problemName);
        setConcepts(problemName);
        setRelatedProblems(problemName);
        
        activeProblem = problemName;
    }
    
    setNotes(activeProblem);
    setMyWeakConcepts();
    previousProblem = problemName;
}

// =========================================================
// 6. CO-FT 문제 관리
// =========================================================

function renderGeneratedProblemsList() {
    const listContainer = document.getElementById('generated-problems-list');
    if (!noteManager) return;
    const problems = noteManager.getGeneratedProblems();

    if (problems.length === 0) {
        listContainer.innerHTML = '<p style="color:#999; font-size:0.9em; text-align:center; padding:20px;">저장된 문제가 없습니다.</p>';
        return;
    }

    listContainer.innerHTML = '';
    problems.forEach(p => {
        const item = document.createElement('div');
        const isActive = currentGeneratedProblem && currentGeneratedProblem.id === p.id;
        item.className = `generated-problem-item ${isActive ? 'active' : ''}`;
        
        const dateObj = new Date(p.timestamp);
        const dateStr = `${dateObj.getFullYear()}. ${dateObj.getMonth()+1}. ${dateObj.getDate()}.`;
        
        item.innerHTML = `
            <div class="gen-prob-info">
                <div class="gen-prob-title">${p.title}</div>
                <div class="gen-prob-meta">
                    <span class="gen-prob-badge">${p.difficulty}</span>
                    <span class="gen-prob-date">${dateStr}</span>
                </div>
            </div>
            <span class="delete-btn delete-problem-btn" data-id="${p.id}" title="문제 삭제">✕</span>
        `;
        
        item.addEventListener('click', (e) => {
            if(e.target.classList.contains('delete-problem-btn')) return;
            loadGeneratedProblem(p);
        });

        item.querySelector('.delete-problem-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            if (confirm("이 문제를 삭제하시겠습니까? (관련 오답노트도 함께 정리됩니다)")) {
                noteManager.deleteGeneratedProblem(p.id);
                if (currentGeneratedProblem && currentGeneratedProblem.id === p.id) {
                    currentGeneratedProblem = null;
                    document.getElementById('generated-problem-display').innerHTML = '<p style="color:#999; text-align:center; margin-top:50px;">문제가 삭제되었습니다.</p>';
                    editor.setValue("// 문제 선택 필요");
                    activeProblem = "CO-FT PROBLEM";
                }
                renderGeneratedProblemsList();
                setNotes(activeProblem);
                setMyWeakConcepts(); 
            }
        });

        listContainer.appendChild(item);
    });
}

function loadGeneratedProblem(problem) {
    currentGeneratedProblem = problem;
    activeProblem = problem.id;

    document.getElementById('generated-problem-display').innerHTML = problem.htmlContent;
    editor.setValue(problem.starterCode);
    renderGeneratedProblemsList();
    setNotes(activeProblem);

    loadCoFtTabContent('Solution');
    loadCoFtTabContent('개념');
    loadCoFtTabContent('선행 문제');
}

function initializeCoFtProblem() {
    const generateBtn = document.getElementById('generate-problem-btn');
    const verifyBtn = document.getElementById('verify-button');

    if (noteManager) renderGeneratedProblemsList();

    generateBtn.addEventListener('click', async () => {
        const difficulty = document.getElementById('difficulty-select').value;
        generateBtn.disabled = true;
        generateBtn.textContent = "생성 중... ⏳";

        try {
            const result = await ipcRenderer.invoke('generate-co-ft-problem', difficulty);
            
            const newProblem = {
                id: `CO-FT-${Date.now()}`,
                title: result.title || `AI Generated (${difficulty})`, 
                difficulty: difficulty,
                htmlContent: result.htmlContent,
                starterCode: result.starterCode,
                solutionLogic: result.solutionLogic,
                timestamp: new Date().toISOString(),
                cachedTabs: {} 
            };

            if (noteManager) noteManager.addGeneratedProblem(newProblem);
            loadGeneratedProblem(newProblem);
            
        } catch (error) {
            alert("문제 생성 실패: " + error.message);
        } finally {
            generateBtn.disabled = false;
            generateBtn.textContent = "🤖 문제 생성하기";
        }
    });

    verifyBtn.addEventListener('click', async () => {
        if (!currentGeneratedProblem) {
            alert("검증할 문제가 없습니다.");
            return;
        }
        
        document.getElementById('tab-test-results-button').click();
        const resDiv = document.getElementById('test-results-content');
        resDiv.innerHTML = "<p style='padding:20px; text-align:center;'>⏳ 코드를 채점 중입니다... <br>(약 3~5초 소요)</p>";

        try {
            const result = await ipcRenderer.invoke('verify-co-ft-solution', {
                problem: currentGeneratedProblem,
                userCode: editor.getValue()
            });
            
            resDiv.innerHTML = result.htmlReport;

            if (!result.isPass) {
                if (noteManager) {
                    const fakeResult = {
                        status: "Failed",
                        tests: [
                            { 
                                status: "Failed", 
                                testcase_name: "AI 검증 테스트", 
                                reason: "AI 채점 결과 실패" 
                            }
                        ]
                    };
                    noteManager.addNote(activeProblem, editor.getValue(), fakeResult);
                    setNotes(activeProblem);
                    setMyWeakConcepts(); 
                }
            }

        } catch (error) {
            resDiv.innerHTML = `<p style="color:red">검증 통신 오류: ${error.message}</p>`;
        }
    });
}

// =========================================================
// 7. 커리큘럼 및 초기화
// =========================================================

function initializeCurriculumCommand() {
    document.getElementById('curriculum-button').addEventListener('click', () => {
        let wc = [];
        if (noteManager) {
            const ignoredList = noteManager.getIgnoredConcepts();
            const existingGeneratedProblems = noteManager.getGeneratedProblems().map(p => p.id);

            noteManager.getAllNotes().forEach(n => {
                if (n.problemName.startsWith("CO-FT-") && !existingGeneratedProblems.includes(n.problemName)) {
                    return;
                }

                if (n.aiAnalysis?.conceptSummary?.concepts) {
                    n.aiAnalysis.conceptSummary.concepts.forEach(c => {
                        if (!ignoredList.includes(c.name)) wc.push(c.name);
                    });
                }
            });
        }
        ipcRenderer.send('open-curriculum-window', [...new Set(wc)]);
    });
}

function initializeProblemsCombo(problemNames) {
    var select = document.getElementById('problem-select');
    problemNames.forEach(name => {
        var opt = document.createElement('option');
        opt.value = name; opt.textContent = name;
        select.appendChild(opt);
    });
    var coft = document.createElement('option');
    coft.value = "CO-FT PROBLEM";
    coft.textContent = "CO-FT PROBLEM (AI 생성)";
    select.appendChild(coft);
    select.addEventListener('change', (e) => onProblemSelected(e.target.value));
}

function initializeSaveCommand() {
    ipcRenderer.on('save-command', () => saveSolution('cpp', editor.getValue()));
    document.getElementById('save-button').addEventListener('click', () => saveSolution('cpp', editor.getValue()));
}
function initializeRunCommand() {
    ipcRenderer.on('run-command', () => {
        document.getElementById('compilation-content').innerHTML = "";
        document.getElementById('test-results-content').innerHTML = "";
        run(setTestResults);
    });
    document.getElementById('run-button').addEventListener('click', () => {
        document.getElementById('compilation-content').innerHTML = "";
        document.getElementById('test-results-content').innerHTML = "";
        run(setTestResults);
    });
}
function initializeCustomTestcaseCommand() {
    ipcRenderer.on('custom-testcase-command', () => runCustomTestcase());
    document.getElementById('custom-testcase-button').addEventListener('click', () => runCustomTestcase());
}
function initializeAddNoteButton() {
    document.getElementById('add-note-button').addEventListener('click', () => {
        if (!activeProblem || !noteManager) return alert("문제 선택 필요");
        noteManager.addNote(activeProblem, editor.getValue(), { 
            status: "Manual", tests: [{ status: "Failed", testcase_name: "수동 저장" }] 
        });
        setNotes(activeProblem);
        alert("오답 노트 저장 완료");
    });
}
function initializeNoteDeletion() {
    document.getElementById('notes-content').addEventListener('click', (e) => {
        if (e.target.classList.contains('delete-note-btn')) {
            if (confirm('이 기록을 삭제하시겠습니까?')) {
                noteManager.deleteNote(e.target.dataset.timestamp);
                setNotes(activeProblem);
                setMyWeakConcepts();
            }
        }
    });
}
function initializeNoteAnalysis() {
    document.getElementById('notes-content').addEventListener('click', async (e) => {
        if (e.target.classList.contains('ai-analysis-btn')) {
            const btn = e.target;
            const ts = btn.dataset.timestamp;
            btn.disabled = true; btn.textContent = "분석 중...";
            try {
                const note = noteManager.getAllNotes().find(n => n.timestamp === ts);
                const result = await ipcRenderer.invoke('request-ai-analysis', {
                    problemName: note.problemName,
                    code: note.code,
                    results: note.results
                });
                noteManager.saveAiAnalysis(ts, result);
                setNotes(activeProblem);
                setMyWeakConcepts();
            } catch (err) {
                alert(err.message);
                btn.disabled = false; btn.textContent = "🔍 AI 분석 요청";
            }
        }
    });
}

document.addEventListener('DOMContentLoaded', async () => {
    try {
        noteManager = await createNoteManager();
        console.log('NoteManager Loaded');
    } catch (e) { console.error(e); }

    initializeProblemsCombo(directoryManager.getProblemNames());
    initializeSaveCommand();
    initializeRunCommand();
    initializeCustomTestcaseCommand();
    initializeCurriculumCommand();
    initializeAddNoteButton();
    initializeNoteDeletion();
    initializeNoteAnalysis();
    
    // [중요] 정답 코드 생성기 초기화
    initializeSolutionGenerator();
    
    initializeCoFtProblem();

    amdRequire(['vs/editor/editor.main'], function() {
        monaco.editor.setTheme('vs-light');
        editor = monaco.editor.create(document.getElementById('user-solution-content'), {
            language: 'cpp',
            minimap: { enabled: false },
            scrollbar: { vertical: 'auto', horizontal: 'auto' },
            automaticLayout: true,
            scrollBeyondLastLine: true
        });
        
        if (directoryManager.getProblemNames().length > 0) {
            onProblemSelected(directoryManager.getProblemNames()[0]);
        }
    });

    document.querySelectorAll('.tab').forEach(tab => {
        tab.addEventListener('click', function() {
            if (this.parentNode.classList.contains('panel-item-fixed-height')) {
                document.querySelectorAll('.tab-content-left').forEach(c => c.classList.remove('active'));
                const map = {
                    'Description': 'tab-description', 'Solution': 'tab-solution',
                    '개념': 'tab-개념', '선행 문제': 'tab-선행-문제',
                    '오답 노트': 'tab-오답-노트', '나의 취약개념': 'tab-나의-취약개념'
                };
                const targetId = map[this.textContent];
                if (targetId) document.getElementById(targetId).classList.add('active');
                
                if (activeProblem && activeProblem.startsWith("CO-FT")) {
                    loadCoFtTabContent(this.textContent);
                }
            } 
            else if (this.id.startsWith('tab-')) {
                document.querySelectorAll('.tab-bottom-right, .tab-compilation, #tab-testcase').forEach(c => c.classList.remove('active'));
                let tId = '';
                if (this.textContent === 'Test Results') tId = 'tab-test-results';
                else if (this.textContent === 'Testcase') tId = 'tab-testcase';
                else if (this.textContent === 'Compilation') tId = 'tab-compilation';
                
                if (tId) document.getElementById(tId).classList.add('active');
            }

            this.parentNode.querySelectorAll('.tab').forEach(t => t.classList.remove('selected'));
            this.classList.add('selected');
        });
    });

    Split(['#left-panel', '#right-panel'], { minSize: 100, sizes: [50, 50], gutterSize: 7 });
    Split(['#top-right-panel', '#bottom-right-panel'], { minSize: 100, sizes: [60, 40], gutterSize: 7, direction: 'vertical', cursor: 'row-resize' });
});
