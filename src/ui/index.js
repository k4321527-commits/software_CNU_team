const path = require('path')
const file = require('fs');
const amdLoader = require('monaco-editor/min/vs/loader.js');
const Split = require('split.js')
const { ipcRenderer } = require('electron');
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

function validateResults(results) {
    try {
        const schema = directoryManager.getResultsSchemaJson();
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

// [병합됨] '반례' 기능과 '오답노트' 기능이 합쳐진 setTestResults
function setTestResults(results) {
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

        // [반례 기능] 테스트 실패 시 .txt 파일로 저장
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

        // [반례 기능] UI에 한글 라벨로 표시
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

    // [오답 노트 기능] 테스트 실패 시 자동으로 오답 노트 저장
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

// [병합됨] 'error-translator' 기능과 'problemBuildsDir' 설정이 합쳐진 run
function run(callback, testcase = 'All', expected = false) {
    saveSolution('cpp', editor.getValue());
    const pathsFile = DirectoryManager.getPathsFile();
    if (!file.existsSync(pathsFile)) {
        throw new Error(`Paths file does not exist: ${pathsFile}`);
    }

    // [반례 기능] 전역 변수에 problemBuildsDir 설정 (setTestResults에서 사용)
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
        
        // [오답 노트 기능] innerHTML 사용
        element.innerHTML = "";
        
        resultsFilename = parseResultsFileFromStdout(stdout);
        if (!resultsFilename || !file.existsSync(resultsFilename)) {
            console.log("Setting error");
            console.log("Error running the command, error: " + error +
                ", stderr: " + stderr + ", stdout: " + stdout);

            // [오답 노트 기능] 에러 번역기 사용
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

// [오답 노트 기능] 힌트 탭 설정
function setHints(problemName) {
    const content = document.getElementById('hint-content');
    const metadata = directoryManager.getMetadata(problemName);
    if (metadata.hints && metadata.hints.length > 0) {
        content.innerHTML = `<ul>${metadata.hints.map(hint => `<li>${hint}</li>`).join('')}</ul>`;
    } else {
        content.innerHTML = "<p>등록된 힌트가 없습니다.</p>";
    }
}

// [오답 노트 기능] 선행 개념 탭 설정
function setPrerequisites(problemName) {
    const content = document.getElementById('prerequisites-content');
    const metadata = directoryManager.getMetadata(problemName);
    if (metadata.prerequisites && metadata.prerequisites.length > 0) {
        content.innerHTML = `<ul>${metadata.prerequisites.map(item => `<li>${item}</li>`).join('')}</ul>`;
    } else {
        content.innerHTML = "<p>등록된 선행 개념이 없습니다.</p>";
    }
}

// [오답 노트 기능] 오답 노트 탭 설정
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
        // 수동 저장 시 failedTest가 없을 수 있으므로 (Manual Save), 기본값 처리
        const testName = failedTest ? failedTest.testcase_name : (note.results.testcase_filter_name || "저장");
        const input = (failedTest && failedTest.input) ? JSON.stringify(failedTest.input) : 'N/A';
        const expected = (failedTest && failedTest.expected) ? JSON.stringify(failedTest.expected) : 'N/A';
        const actual = (failedTest && failedTest.actual) ? JSON.stringify(failedTest.actual) : 'N/A';
        
        return `
            <div class="note-item">
                <details>
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
                        
                        <h4>당시 제출 코드</h4>
                        <pre><code>${note.code.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</code></pre>
                    </div>
                </details>
            </div>
        `;
    }).join('');
}


var previousProblem;
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
    
    // [오답 노트 기능] 새 탭들 컨텐츠 설정
    setHints(problemName);
    setPrerequisites(problemName);
    setNotes(problemName);
    
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

// [오답 노트 기능] 커리큘럼 버튼 초기화
function initializeCurriculumCommand() {
    document.getElementById('curriculum-button').addEventListener('click', () => {
        console.log('Curriculum button clicked');
        ipcRenderer.send('open-curriculum-window');
    });
}

// [오답 노트 기능] '오답 노트로 저장' 버튼 기능 초기화
function initializeAddNoteButton() {
    document.getElementById('add-note-button').addEventListener('click', () => {
        console.log('Add note button clicked');
        if (!activeProblem || !noteManager) {
            alert("문제를 먼저 선택해주세요.");
            return;
        }

        const currentCode = editor.getValue();
        // 수동 저장이므로, 테스트 결과(results) 객체를 직접 만들어줍니다.
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
        setNotes(activeProblem); // 오답 노트 탭 새로고침
        alert("현재 코드를 오답 노트에 저장했습니다.");
    });
}

// [오답 노트 기능] 오답 노트 삭제 기능 초기화
function initializeNoteDeletion() {
    const notesContainer = document.getElementById('notes-content');
    notesContainer.addEventListener('click', (event) => {
        if (event.target.classList.contains('delete-note-btn')) {
            const timestamp = event.target.dataset.timestamp;
            if (timestamp && noteManager) {
                if (confirm('이 오답 기록을 정말로 삭제하시겠습니까?')) {
                    noteManager.deleteNote(timestamp);
                    setNotes(activeProblem);
                }
            }
        }
    });
}

// [오답 노트 기능] 비동기 noteManager 로딩 포함
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
    
    // [오답 노트 기능] 새 기능 초기화
    initializeCurriculumCommand();
    initializeAddNoteButton(); 
    initializeNoteDeletion();

    amdRequire(['vs/editor/editor.main'], function() {
        monaco.editor.setTheme('vs-dark');
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
        
        // onProblemSelected는 noteManager가 로드된 후 호출되어야 함
        // (setNotes 함수가 noteManager를 사용하기 때문)
        if (problemNames.length > 0) {
            onProblemSelected(problemNames[0]);
        }
    });

    tabs.forEach(tab => {
        tab.addEventListener('click', function(event) {
            console.log('Tab clicked: ' + this.textContent);
            var tabContents = event.target.parentNode.parentNode.querySelectorAll('.tab-content');
            tabContents.forEach(content => {
                content.classList.remove('active');
            });
            
            // [오답 노트 기능] 탭 이름에 공백이 있어도 하이픈(-)으로 변환
            var paneId = this.textContent.toLowerCase().replace(/\s/g, '-');
            var selectedPane = document.getElementById('tab-' + paneId);
            if (selectedPane) {
                selectedPane.classList.add('active');
            }
        });
    });
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
});