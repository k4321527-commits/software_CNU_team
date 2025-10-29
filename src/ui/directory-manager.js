const path = require('path');
const fs = require('fs');

global.dirDict = null;
global.languages = null;
global.problemNames = null;
global.resultsSchemaJson = null;

global.problemBuildsDir = null;

LANGUAGES_DIR_NAME = "languages";
PROBLEMS_DIR_NAME = "problems";
TESTCASES_DIR_NAME = "testcases";
RESULTS_VALIDATION_SCHEMA_FILENAME = "results_validation_schema.json";

function getPathsFile() {
    return path.resolve("filePaths.tmp")
}

function readMdFile(filePath) {
    const marked = require('marked');
    marked.setOptions({
        breaks: false,
    });
    // 파일이 존재하지 않을 수 있으므로 체크
    if (!fs.existsSync(filePath)) {
        return `File does not exist: ${filePath}`;
    }
    const data = fs.readFileSync(filePath, 'utf8');
    return marked.marked(data);
}

function populateLanguages(languagesDir) {
    var languages = [];
    fs.readdirSync(languagesDir).forEach(language => {
        languages.push(language);
    });
    return languages;
}

function populateProblems(problemsDir) {
    var problems = [];
    fs.readdirSync(problemsDir).forEach(problemName => {
        problems.push(problemName);
    });
    return problems;
}

function calculateDirectories() {
    if (global.dirDict) {
        return;
    }

    const pathsFile = getPathsFile();
    if (!fs.existsSync(pathsFile)) {
        throw new Error(`Paths file does not exist: ${pathsFile}`);
    }

    global.problemBuildsDir = fs.readFileSync(pathsFile, 'utf8');

    localDirDict = {};

    const problemsDir = path.join(problemBuildsDir, PROBLEMS_DIR_NAME);
    if (!fs.existsSync(problemsDir)) {
        throw new Error(`Problems directory does not exist: ${problemsDir}`);
    }

    const languagesDir = path.join(problemBuildsDir, LANGUAGES_DIR_NAME);
    if (!fs.existsSync(languagesDir)) {
        throw new Error(`Languages directory does not exist: ${languagesDir}`);
    }

    const languages = populateLanguages(languagesDir);
    const problemNames = populateProblems(problemsDir);

    fs.readdirSync(problemsDir).forEach(problemName => {
        // For now assume cpp, later expand to all languages
        const language = "cpp";
        const problemDir = path.join(problemsDir, problemName);
        const descriptionFile = path.join(problemDir, 'description.md');
        const solutionFile = path.join(problemDir, language, 'solution.md');
        const userSolutionFilename = path.join(problemDir, language, 'solution.cpp');
        
        // ===== METADATA.JSON 읽기 로직 추가 시작 =====
        const metadataFile = path.join(problemDir, 'metadata.json');
        let metadata = {};
        if (fs.existsSync(metadataFile)) {
            try {
                metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
            } catch (e) {
                console.error(`Error parsing metadata.json for ${problemName}:`, e);
            }
        }
        // ===== METADATA.JSON 읽기 로직 추가 끝 =====

        if (!fs.existsSync(userSolutionFilename)) {
            throw new Error(`User solution file does not exist: ${userSolutionFilename}`);
        }

        global.localDirDict[problemName] =
            global.localDirDict[problemName] || {};
        global.localDirDict[problemName]["description"] =
            readMdFile(descriptionFile);
        
        // ===== 읽어온 메타데이터 저장 =====
        global.localDirDict[problemName]["metadata"] = metadata;

        global.localDirDict[problemName][language] =
            global.localDirDict[problemName][language] || {};
            global.localDirDict[problemName][language]["solution"] =
                readMdFile(solutionFile);
            global.localDirDict[problemName][language]
                ["user-solution-filename"] = userSolutionFilename;
    });

    const resultsSchemaFilename =
        path.join(problemBuildsDir, RESULTS_VALIDATION_SCHEMA_FILENAME);

    if (!fs.existsSync(resultsSchemaFilename)) {
        throw new Error(`Results validation schema file 
                            does not exist: 
                            ${resultsSchemaFilename}`);
    }

    resultsSchema = fs.readFileSync(resultsSchemaFilename, 'utf8');

    
    const resultsSchemaJson = JSON.parse(resultsSchema);

    if (!resultsSchemaJson) {
        throw new Error(`Could not parse results validation schema from 
                        ${resultsSchema}`);
    }
    
    global.dirDict = localDirDict;
    global.languages = languages;
    global.problemNames = problemNames;
    global.resultsSchemaJson = resultsSchemaJson;
}

class DirectoryManager {
    constructor() {
        console.log("Initializing DirectoryManager");
        calculateDirectories();
    }

    getDescription(problemName) {
        return global.dirDict[problemName]["description"];
    }

    getSolution(problemName) {
        return global.dirDict[problemName]["cpp"]["solution"];
    }

    // ===== 메타데이터를 가져오는 GETTER 함수 추가 =====
    getMetadata(problemName) {
        return global.dirDict[problemName]["metadata"] || {};
    }

    getUserSolutionFilename(problemName) {
        return global.dirDict[problemName]["cpp"]["user-solution-filename"];
    }

    getLanguages() {
        return [...global.languages];
    }

    getProblemNames() {
        return [...global.problemNames];
    }
    
    getResultsSchemaJson() {
        return global.resultsSchemaJson;
    }

    getCustomTestcaseName() {
        return "_custom_testcase";
    }

    getCustomTestcaseFilename(problemName) {
        return path.join(problemBuildsDir,
                         PROBLEMS_DIR_NAME,
                         problemName,
                         TESTCASES_DIR_NAME,
                         this.getCustomTestcaseName() + '.test');
    }
}

module.exports = {
    DirectoryManager,
    getPathsFile,
};