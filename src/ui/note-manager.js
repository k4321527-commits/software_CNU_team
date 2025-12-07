const path = require('path');
const fs = require('fs');
const { ipcRenderer } = require('electron');

class NoteManager {
    constructor(userDataPath) {
        this.baseDir = userDataPath;
        this.notesFilePath = path.join(userDataPath, 'notes.json');
        this.generatedProblemsPath = path.join(userDataPath, 'generated_problems.json'); // 생성된 문제 저장 파일
        this.ignoredConceptsPath = path.join(userDataPath, 'ignored_concepts.json'); // 삭제한 취약 개념 저장 파일
        
        this.notes = this.loadData(this.notesFilePath, []);
        this.generatedProblems = this.loadData(this.generatedProblemsPath, []);
        this.ignoredConcepts = this.loadData(this.ignoredConceptsPath, []);
    }

    loadData(filePath, defaultVal) {
        try {
            if (!fs.existsSync(filePath)) return defaultVal;
            return JSON.parse(fs.readFileSync(filePath, 'utf8'));
        } catch (error) {
            console.error(`Error loading ${filePath}:`, error);
            return defaultVal;
        }
    }

    saveData(filePath, data) {
        try {
            fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
        } catch (error) {
            console.error(`Error saving ${filePath}:`, error);
        }
    }

    // --- 오답 노트 관련 ---
    saveNotes() { this.saveData(this.notesFilePath, this.notes); }
    
    addNote(problemName, code, results) {
        const newNote = {
            problemName: problemName,
            timestamp: new Date().toISOString(),
            code: code,
            results: results,
            aiAnalysis: null
        };
        this.notes.push(newNote);
        this.saveNotes();
    }
    
    saveAiAnalysis(timestamp, aiAnalysis) {
        const noteIndex = this.notes.findIndex(note => note.timestamp === timestamp);
        if (noteIndex !== -1) {
            this.notes[noteIndex].aiAnalysis = aiAnalysis;
            this.saveNotes();
        }
    }

    getNotes(problemName) {
        // CO-FT 문제는 ID로 필터링하거나 전체 이름으로 필터링
        return this.notes
            .filter(note => note.problemName === problemName)
            .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    }

    getAllNotes() { return this.notes; }

    deleteNote(timestamp) {
        this.notes = this.notes.filter(note => note.timestamp !== timestamp);
        this.saveNotes();
    }

    // --- [추가] 취약 개념 삭제 기능 ---
    ignoreConcept(conceptName) {
        if (!this.ignoredConcepts.includes(conceptName)) {
            this.ignoredConcepts.push(conceptName);
            this.saveData(this.ignoredConceptsPath, this.ignoredConcepts);
        }
    }

    getIgnoredConcepts() { return this.ignoredConcepts; }

    // --- [추가] CO-FT 생성 문제 관리 기능 ---
    addGeneratedProblem(problemData) {
        this.generatedProblems.push(problemData);
        this.saveData(this.generatedProblemsPath, this.generatedProblems);
    }

    getGeneratedProblems() { return this.generatedProblems; }

    deleteGeneratedProblem(id) {
        this.generatedProblems = this.generatedProblems.filter(p => p.id !== id);
        this.saveData(this.generatedProblemsPath, this.generatedProblems);
    }
}

async function createNoteManager() {
    const userDataPath = await ipcRenderer.invoke('get-user-data-path');
    return new NoteManager(userDataPath);
}

module.exports = createNoteManager;
