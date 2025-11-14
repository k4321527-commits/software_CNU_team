const path = require('path')
const file = require('fs');
const amdLoader = require('monaco-editor/min/vs/loader.js');
const Split = require('split.js')
// 'shell' 모듈을 electron에서 가져옵니다.
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
var problemBuildsDir; // .txt 파일 저장을 위해 전역 변수로 선언

amdRequire.config({
    baseUrl: path.join(__dirname, './node_modules/monaco-editor/min')
});

var activeProblem = null;
var previousProblem; // saveSolution에서 사용되도록 유지

self.module = undefined;

function saveSolution(language, content) {
    if (!previousProblem) {
        return;
    }
    const userSolutionFilename =
        directoryManager.getUserSolutionFilename(previousProblem);
    if (file.existsSync(userSolutionFilename) &&
        file.readFileSync(userSolutionFilename, 'utf8') === content) {
        console.log("No changes to save");
        return;
    }
    console.log("Saving problem " + previousProblem + " to " +
        userSolutionFilename);
    file.writeFileSync(userSolutionFilename, content);
}

function parseResultsFileFromStdout(stdout) {
    match = stdout.match(/Results written to (.*\.results)/);
    if (!match || match.length === 0) {
        return null;
    }
    return match[1];
}

function parseBuildError(stdout) {
    const regex = /cmake --build[\s\S]*?cmake --build/;
    const match = stdout.match(regex);
    if (!match || match.length === 0) {
        return stdout;
    }
    const buildError = match[0].split('\n').slice(1, -1).join('\n');
    return buildError;
}

// [수정] validateResults 함수 수정
function validateResults(results) {
    try {
        // 1. 스키마를 가져옵니다. (directory-manager.js에서 이제 복사본을 줍니다)
        const schema = directoryManager.getResultsSchemaJson();

        // 2. [!!! 여기가 수정된 부분 !!!]
        // 'Invalid URL' 오류를 방지하기 위해, 
        // jsonschema 라이브러리가 잘못 해석할 수 있는 '$id' 속성을 검증 전에 제거합니다.
        if (schema.hasOwnProperty('$id')) {
            delete schema['$id'];
        }
        
        // 3. 이제 검증을 수행합니다.
        const v = new Validator();
        const validation = v.validate(results, schema);
        if (!validation.valid) {
            console.error("Validation errors:", validation.errors);
            return false;
        }
    } catch (e) {
        // (index.js:87) 오류가 발생했던 곳
        console.error("Error validating data:", e);
        return false;
    }
    return true;
}

function readTestcaseFile(filename) {
    if (filename == undefined) {
        console.error("Testcase file not defined");
        return "Testcase file not defined";
    }
    try {
        var testcaseFileContent = file.readFileSync(filename, "utf8");
        testcaseFileContent =
            testcaseFileContent.replace(/\n/g, "<br>&emsp;");
        return testcaseFileContent;
    } catch (err) {
        console.error(`Error reading file ${filename}:`, err);
        return `Error reading file ${filename}: ${err}`;
    }
}

function setTestResults(results) {
    // (index.js:111) 이제 이 함수가 오류 없이 통과할 것입니다.
    if (!validateResults(results)) {
        return;
    }
    console.log("Setting test results: " + JSON.stringify(results));
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
            const failedTestcasePath = path.join(
                problemBuildsDir,
                "problems",
                activeProblem,
                `${test.testcase_name}_failed.txt`
            );
            let fileContent = `Testcase: ${test.testcase_name}\n`;
            fileContent += `Status: ${test.status}\n`;
            if (test.actual) fileContent += `Actual: ${JSON.stringify(test.actual)}\n`;
            if (test.expected) fileContent += `Expected: ${JSON.stringify(test.expected)}\n`;
            if (test.reason) fileContent += `Reason: ${test.reason}\n`;
            if (testcase) fileContent += `Testcase Content: ${testcase.replace(/<br>&emsp;/g, "\n")}\n`;

            file.writeFileSync(failedTestcasePath, fileContent);
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

    const allTestsPassed = results.tests.every(test => test.status === "Passed");
    if (!allTestsPassed) {
        if (noteManager) {
            console.log("Test failed. Saving incorrect answer note.");
            noteManager.addNote(activeProblem, editor.getValue(), results);
            setNotes(activeProblem);
        } else {
            console.error("NoteManager is not initialized yet.");
        }
    }
}

function run(callback, testcase = 'All', expected = false) {
    saveSolution('cpp', editor.getValue());
    const pathsFile = DirectoryManager.getPathsFile();
    if (!file.existsSync(pathsFile)) {
        throw new Error(`Paths file does not exist: ${pathsFile}`);
    }

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
    console.log("Running command: " + command);
    var resultsFilename;
    exec(command, (error, stdout, stderr) => {
        var element = document.getElementById("compilation-content");
        
        element.innerHTML = "";
        
        resultsFilename = parseResultsFileFromStdout(stdout);
        if (!resultsFilename || !file.existsSync(resultsFilename)) {
            console.log("Setting error");
            console.log("Error running the command, error: " + error +
                ", stderr: " + stderr + ", stdout: " + stdout);

            const parsedError = parseBuildError(stdout || stderr);
            element.innerHTML = translateError(parsedError);

            document.getElementById('tab-compilation-button').click();
            return;
        }

        const results = file.readFileSync(resultsFilename, 'utf8');
        console.log(results);
        const resultsJson = JSON.parse(results);
        var errorcode = resultsJson["errorcode"];
        console.log("errorcode: " + errorcode);
        if (errorcode != undefined && errorcode !== 0) {
            let html = "<p>Errorcode: " + resultsJson.errorcode + "</p>";
            html += "<p>Stdout: " + resultsJson.stdout + "</p>";
            html += "<p>Stderr: " + resultsJson.stderr + "</p>";
            element.innerHTML = html;
            document.getElementById('tab-compilation-button').click();
            return;
        } else {
            console.log("Setting results");
            // (index.js:225) 여기에서 setTestResults가 호출됩니다.
            callback(resultsJson);
        }
    });
}

function setCustomTestcaseResults(results) {
    if (!validateResults(results)) {
        return;
    }
    document.getElementById('testcase-stderr').textContent = results.stderr;
    if (results.tests.length !== 1) {
        console.error("Expected 1 custom test results, got " +
            results.tests.length);
        return;
    }
    if (results.tests[0].status !== "Skipped") {
        console.error("Expected custom test status to be 'skipped', got " +
            results.tests[0].status);
        return;
    }
    console.log("Setting custom testcase results: " + JSON.stringify(results));
    document.getElementById('testcase-stdout').textContent = results.stdout;
    document.getElementById('testcase-output').textContent =
        JSON.stringify(results.tests[0].actual);
    run(setExpectedTestcaseResults, directoryManager.getCustomTestcaseName(),
        true);
    document.getElementById('tab-testcases').click();
}

function setExpectedTestcaseResults(expected) {
    if (!validateResults(expected)) {
        return;
    }
    if (expected.tests.length !== 1) {
        console.error("Expected 1 test results, got " +
            expected.tests.length);
        return;
    }
    if (expected.tests[0].status !== "Skipped") {
        console.error("Expected test status to be 'skipped', got " +
            expected.tests[0].status);
    }
    document.getElementById('expected-output').textContent =
        JSON.stringify(expected.tests[0].actual);
}

function runCustomTestcase() {
    console.log("Running custom testcase for " + activeProblem);
    document.getElementById('testcase-stdout').textContent = "";
    document.getElementById('testcase-stderr').textContent = "";
    document.getElementById('testcase-output').textContent = "";
    document.getElementById('compilation-content').innerHTML = "";
    document.getElementById('test-results-content').innerHTML = "";
    const input = document.getElementById('input-container').value + "\n*";
    const customTestcaseFilename =
        directoryManager.getCustomTestcaseFilename(activeProblem);
    if (!file.existsSync(path.dirname(customTestcaseFilename))) {
        console.log('The directory does not exist. Directory: ' + path.dirname(customTestcaseFilename));
        return;
    }
    file.writeFileSync(customTestcaseFilename, input);
    if (!file.existsSync(customTestcaseFilename)) {
        throw new Error(`Failed to write custom testcase to ` +
            `${customTestcaseFilename}`);
    }
    console.log('Custom testcase written to ' + customTestcaseFilename);
    run(setCustomTestcaseResults, directoryManager.getCustomTestcaseName());
}

function setDescription(problemName) {
    var element =
        document.querySelector('.markdown-content#description-content');
    element.innerHTML = directoryManager.getDescription(problemName);
}

function setSolution(problemName) {
    var element = document.querySelector('.markdown-content#solution-content');
    element.innerHTML = directoryManager.getSolution(problemName);
}

function setUserSolution(problemName) {
    var element = document.querySelector('#user-solution-content');
    const userSolutionFilename =
        directoryManager.getUserSolutionFilename(problemName);
    editor.setValue(file.readFileSync(userSolutionFilename, 'utf8'));
}

function setConcepts(problemName) {
    const content = document.getElementById('concept-content');
    content.innerHTML = `
        <div class="note-content">
            <p>현재 문제(${problemName})를 해결하는 데 필요한 핵심 개념을 AI에게 물어볼 수 있습니다.</p>
            <button id="get-concepts-btn" class="ai-analysis-btn">🧠 AI 핵심 개념 분석</button>
            <div id="ai-concepts-result">
                </div>
        </div>
    `;
    
    document.getElementById('get-concepts-btn').addEventListener('click', async () => {
        const button = document.getElementById('get-concepts-btn');
        const resultDiv = document.getElementById('ai-concepts-result');
        
        button.disabled = true;
        button.textContent = "분석 중...";
        resultDiv.innerHTML = "<p>AI가 핵심 개념을 분석 중입니다...</p>";

        try {
            const description = directoryManager.getDescription(activeProblem);
            const conceptResult = await ipcRenderer.invoke('request-problem-concepts', {
                problemName: activeProblem,
                description: description 
            });
            
            resultDiv.innerHTML = conceptResult;

        } catch (error) {
            console.error('AI 개념 분석 중 오류 발생:', error);
            resultDiv.innerHTML = `<p style="color: #f48771;">AI 분석 중 오류가 발생했습니다: ${error.message}</p>`;
        } finally {
            button.disabled = false;
            button.textContent = "🧠 AI 핵심 개념 분석";
        }
    });
}

function setRelatedProblems(problemName) {
    const content = document.getElementById('related-problems-content');
    content.innerHTML = `
        <div class="note-content">
            <p>현재 문제(${problemName})와 관련된 더 쉬운 문제들을 AI에게 추천받을 수 있습니다.</p>
            <button id="get-related-problems-btn" class="ai-analysis-btn">🚀 관련 문제 추천받기</button>
            <div id="related-problems-container">
                </div>
        </div>
    `;

    document.getElementById('get-related-problems-btn').addEventListener('click', async () => {
        const button = document.getElementById('get-related-problems-btn');
        const container = document.getElementById('related-problems-container');

        button.disabled = true;
        button.textContent = "추천받는 중...";
        container.innerHTML = "<p>AI가 관련 문제를 찾고 있습니다...</p>";

        try {
            const relatedProblemsResult = await ipcRenderer.invoke('request-related-problems', {
                problemName: activeProblem
            });
            
            container.innerHTML = relatedProblemsResult;

        } catch (error) {
            console.error('AI 관련 문제 추천 중 오류 발생:', error);
            container.innerHTML = `<p style="color: #f48771;">AI 추천 중 오류가 발생했습니다: ${error.message}</p>`;
        } finally {
            button.disabled = false;
            button.textContent = "🚀 관련 문제 추천받기";
        }
    });
}

function setNotes(problemName) {
    const content = document.getElementById('notes-content');
    if (!noteManager) {
        content.innerHTML = "<p>오답 노트를 불러오는 중입니다...</p>";
        return;
    }
    const notes = noteManager.getNotes(problemName);
    if (notes.length === 0) {
        content.innerHTML = "<p>아직 이 문제에 대한 오답 기록이 없습니다.</p>";
        return;
    }
    content.innerHTML = notes.map(note => {
        const failedTest = note.results.tests.find(t => t.status !== 'Passed');
        const testName = failedTest ? failedTest.testcase_name : (note.results.testcase_filter_name || "저장");
        const input = (failedTest && failedTest.input) ? JSON.stringify(failedTest.input) : 'N/A';
        const expected = (failedTest && failedTest.expected) ? JSON.stringify(failedTest.expected) : 'N/A';
        const actual = (failedTest && failedTest.actual) ? JSON.stringify(failedTest.actual) : 'N/A';
        
        const aiAnalysis = note.aiAnalysis || null;
        let aiAnalysisHtml = '';

        if (aiAnalysis) {
            const summary = aiAnalysis.conceptSummary;
            let conceptHtml = '';
            
            if (summary && summary.concepts && Array.isArray(summary.concepts)) {
                conceptHtml += summary.title || '<h4>3. 취약 개념 요약 제시 📚</h4>';
                conceptHtml += '<ul>';
                summary.concepts.forEach(concept => {
                    conceptHtml += `<li><strong>${concept.name}:</strong> ${concept.tip}</li>`;
                });
                conceptHtml += '</ul>';
            }

            aiAnalysisHtml = `
                <h4>🌟 AI 오답 분석 결과</h4>
                ${aiAnalysis.reasonAnalysis || ''} 
                ${aiAnalysis.patternAnalysis || ''} 
                ${conceptHtml} 
            `;
        } else {
            aiAnalysisHtml = `<button class="ai-analysis-btn" data-timestamp="${note.timestamp}">🧠 AI 분석 요청</button>`;
        }

        return `
            <div class="note-item">
                <details ${aiAnalysis ? 'open' : ''}>
                    <summary class="note-summary">
                        ${new Date(note.timestamp).toLocaleString()} - 
                        <span class="note-status-fail">오답</span>
                        <span class="delete-note-btn" data-timestamp="${note.timestamp}" title="이 기록 삭제">❌</span>
                    </summary>
                    <div class="note-content">
                        <h4>실패한 테스트케이스: ${testName}</h4>
                        <p><strong>Input:</strong> <code>${input}</code></p>
                        <p><strong>Expected:</strong> <code>${expected}</code></p>
                        <p><strong>My Output:</strong> <code>${actual}</code></p>
                        
                        <hr>
                        ${aiAnalysisHtml}
                        <hr>
                        
                        <h4>당시 제출 코드</h4>
                        <pre><code>${note.code.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</code></pre>
                    </div>
                </details>
            </div>
        `;
    }).join('');
}

function setMyWeakConcepts() {
    const content = document.getElementById('weak-concepts-summary-content');
    if (!noteManager) {
        content.innerHTML = "<p>오답 노트를 불러오는 중입니다...</p>";
        return;
    }

    const allNotes = noteManager.getAllNotes();
    const conceptMap = new Map();

    allNotes.forEach(note => {
        if (note.aiAnalysis && note.aiAnalysis.conceptSummary && note.aiAnalysis.conceptSummary.concepts) {
            note.aiAnalysis.conceptSummary.concepts.forEach(concept => {
                const conceptName = concept.name.split('(')[0].trim();
                const conceptTip = concept.tip;
                
                if (conceptName) {
                    const entry = conceptMap.get(conceptName) || { count: 0, tips: [] };
                    entry.count++;
                    
                    if (!entry.tips.includes(conceptTip)) {
                        entry.tips.push(conceptTip);
                    }
                    conceptMap.set(conceptName, entry);
                }
            });
        }
    });

    if (conceptMap.size === 0) {
        content.innerHTML = `
            <div class="weak-concept-summary">
                <p>아직 집계된 취약 개념이 없습니다.</p>
                <p>오답 노트를 생성하고 <strong>[🧠 AI 분석 요청]</strong> 버튼을 눌러 데이터를 쌓아보세요.</p>
            </div>
        `;
        return;
    }

    const sortedConcepts = Array.from(conceptMap.entries()).sort((a, b) => b[1].count - a[1].count);

    let html = `
        <div class="weak-concept-summary">
            <p>지금까지 AI가 분석한 나의 주요 취약 개념 목록입니다. (클릭하여 누적된 팁 보기)</p>
            <ul class="weak-concept-list">
    `;

    sortedConcepts.forEach(([name, entry]) => {
        html += `
            <li>
                <details class="weak-concept-details">
                    <summary> <span class="weak-concept-name">${name}</span>
                        <span class="weak-concept-count">${entry.count}회 누적</span>
                    </summary>
                    <div class="weak-concept-content"> ${entry.tips.map(tip => `<p>• ${tip}</p>`).join('')}
                    </div>
                </details>
            </li>
        `;
    });

    html += '</ul></div>';
    content.innerHTML = html;
}


function onProblemSelected(problemName) {
    document.getElementById('testcase-stdout').textContent = "";
    document.getElementById('testcase-stderr').textContent = "";
    document.getElementById('testcase-output').textContent = "";
    saveSolution('cpp', editor.getValue());
    previousProblem = problemName;
    console.log(`Problem selected: ${problemName}`);
    setDescription(problemName);
    setSolution(problemName);
    setUserSolution(problemName);
    
    setConcepts(problemName);
    setRelatedProblems(problemName);
    setNotes(problemName);
    
    setMyWeakConcepts();
    
    activeProblem = problemName;
}

function initializeProblemsCombo(problemNames) {
    var select = document.getElementById('problem-select');
    problemNames.forEach(problemName => {
        var option = document.createElement('option');
        option.value = problemName;
        option.textContent = problemName;
        select.appendChild(option);
    });
    select.addEventListener('change', function(event) {
        onProblemSelected(event.target.value);
    });
}

function initializeSaveCommand() {
    ipcRenderer.on('save-command', () => {
        console.log('Received save command');
        saveSolution('cpp', editor.getValue());
    });
    document.getElementById('save-button')
        .addEventListener('click', function() {
            console.log('Save button clicked');
            saveSolution('cpp', editor.getValue());
        });
}

function initializeRunCommand() {
    ipcRenderer.on('run-command', () => {
        console.log('Received run command');
        document.getElementById('compilation-content').innerHTML = "";
        document.getElementById('test-results-content').innerHTML = "";
        run(setTestResults);
    });
    document.getElementById('run-button')
        .addEventListener('click', function() {
            console.log('Run button clicked');
            document.getElementById('compilation-content').innerHTML = "";
            document.getElementById('test-results-content').innerHTML = "";
            run(setTestResults);
        });
}

function initializeCustomTestcaseCommand() {
    ipcRenderer.on('custom-testcase-command', () => {
        console.log('Received custom testcase command');
        runCustomTestcase();
    });
    document.getElementById('custom-testcase-button')
        .addEventListener('click', function() {
            console.log('Custom testcase button clicked');
            runCustomTestcase();
        });
}

function initializeCurriculumCommand() {
    document.getElementById('curriculum-button').addEventListener('click', () => {
        console.log('Curriculum button clicked');
        ipcRenderer.send('open-curriculum-window');
    });
}

function initializeAddNoteButton() {
    document.getElementById('add-note-button').addEventListener('click', () => {
        console.log('Add note button clicked');
        if (!activeProblem || !noteManager) {
            alert("문제를 먼저 선택해주세요.");
            return;
        }

        const currentCode = editor.getValue();
        const manualResults = {
            status: "Manual Save",
            duration_ms: 0,
            testcase_filter_name: "Manual",
            tests: [{
                status: "Failed (Manual)",
                testcase_name: "수동 저장",
                reason: "사용자가 직접 '오답 노트로 저장' 버튼을 클릭했습니다."
            }]
        };

        noteManager.addNote(activeProblem, currentCode, manualResults);
        setNotes(activeProblem);
        alert("현재 코드를 오답 노트에 저장했습니다.");
    });
}

function initializeNoteDeletion() {
    const notesContainer = document.getElementById('notes-content');
    notesContainer.addEventListener('click', (event) => {
        if (event.target.classList.contains('delete-note-btn')) {
            const timestamp = event.target.dataset.timestamp;
            if (timestamp && noteManager) {
                if (confirm('이 오답 기록을 정말로 삭제하시겠습니까?')) {
                    noteManager.deleteNote(timestamp);
                    setNotes(activeProblem);
                    setMyWeakConcepts();
                }
            }
        }
    });
}

function initializeNoteAnalysis() {
    const notesContainer = document.getElementById('notes-content');
    notesContainer.addEventListener('click', async (event) => {
        if (event.target.classList.contains('ai-analysis-btn')) {
            const button = event.target;
            const timestamp = button.dataset.timestamp;
            
            if (!timestamp || !noteManager) {
                alert("오답 기록을 불러올 수 없습니다.");
                return;
            }

            button.disabled = true;
            button.textContent = "분석 중... (잠시만 기다려주세요)";

            try {
                const note = noteManager.getAllNotes().find(n => n.timestamp === timestamp);
                if (!note) throw new Error("Note not found.");
                
                const historicalPatterns = noteManager.getAllNotes()
                    .filter(n => n.aiAnalysis && n.aiAnalysis.patternAnalysis) 
                    .map(n => n.aiAnalysis.patternAnalysis); 

                const analysisData = {
                    problemName: note.problemName,
                    code: note.code,
                    results: note.results,
                    historicalPatterns: historicalPatterns
                };

                const analysisResult = await ipcRenderer.invoke('request-ai-analysis', analysisData);

                noteManager.saveAiAnalysis(timestamp, analysisResult);
                setNotes(activeProblem);
                setMyWeakConcepts();
                
            } catch (error) {
                console.error('AI 분석 중 오류 발생:', error);
                alert('AI 분석 중 오류가 발생했습니다: ' + error.message);
            } finally {
                if (button.textContent.includes('분석 중')) {
                    button.disabled = false;
                    button.textContent = "🧠 AI 분석 요청";
                }
            }
        }
    });
}

document.addEventListener('DOMContentLoaded', async (event) => {
    try {
        noteManager = await createNoteManager();
        console.log('NoteManager initialized successfully.');
    } catch (error) {
        console.error('Failed to initialize NoteManager:', error);
    }

    var tabs = document.querySelectorAll('.tab');
    const problemNames = directoryManager.getProblemNames();
    initializeProblemsCombo(problemNames);
    initializeSaveCommand();
    initializeRunCommand();
    initializeCustomTestcaseCommand();
    
    initializeCurriculumCommand();
    initializeAddNoteButton(); 
    initializeNoteDeletion();
    initializeNoteAnalysis();
    
    amdRequire(['vs/editor/editor.main'], function() {
        monaco.editor.setTheme('vs-light'); // 테마를 'vs-light'로 변경
        editor = monaco.editor.create(
            document.getElementById('user-solution-content'), {
                language: 'cpp',
                minimap: {
                    enabled: false
                },
                scrollbar: {
                    vertical: 'auto',
                    horizontal: 'auto'
                },
                automaticLayout: true,
                scrollBeyondLastLine: false
            });
        
        if (problemNames.length > 0) {
            onProblemSelected(problemNames[0]);
        }
    });

    tabs.forEach(tab => {
        tab.addEventListener('click', function(event) {
            console.log('Tab clicked: ' + this.textContent);
            // 이전에 선택된 탭의 'selected' 클래스 제거
            tabs.forEach(t => t.classList.remove('selected'));
            // 현재 클릭된 탭에 'selected' 클래스 추가
            this.classList.add('selected');

            var tabContents = event.target.parentNode.parentNode.querySelectorAll('.tab-content');
            tabContents.forEach(content => {
                content.classList.remove('active');
            });
            
            var paneId = this.textContent.toLowerCase().replace(/\s/g, '-');
            var selectedPane = document.getElementById('tab-' + paneId);
            if (selectedPane) {
                selectedPane.classList.add('active');
            }
        });
    });

    // 페이지 로드 시 첫 번째 탭(Description)을 기본으로 선택
    if(tabs.length > 0) {
        tabs[0].classList.add('selected');
    }
});

document.addEventListener('DOMContentLoaded', (event) => {
    Split(['#left-panel', '#right-panel'], {
        minSize: 100,
        sizes: [50, 50],
        gutterSize: 7,
    })
    Split(['#top-right-panel', '#bottom-right-panel'], {
        minSize: 100,
        sizes: [60, 40],
        gutterSize: 7,
        direction: 'vertical',
        cursor: 'row-resize',
    })

    // [추가] (요청 1) 관련 문제 탭의 외부 링크 클릭 처리
    // 전역 클릭 리스너를 추가하여, 동적으로 생성된 <a> 태그도 처리
    document.addEventListener('click', (event) => {
        // 클릭된 요소 또는 그 부모가 <a> 태그인지 확인
        const link = event.target.closest('a');
        
        // 1. 링크가 존재하고, 
        // 2. href가 http로 시작하고,
        // 3. 이 링크가 'related-problems-container' 내부에 있는지 확인
        if (link && link.href.startsWith('http') && link.closest('#related-problems-container')) {
            // Electron의 기본 동작(앱 내에서 링크 열기 시도)을 막습니다.
            event.preventDefault();
            // Electron의 shell 모듈을 사용해 시스템 기본 브라우저에서 엽니다.
            console.log('Opening external link:', link.href);
            shell.openExternal(link.href);
        }
    });
});
