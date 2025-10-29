const path = require('path');
const fs = require('fs');
const { ipcRenderer } = require('electron');

class NoteManager {
<<<<<<< HEAD
    constructor(userDataPath) {
        this.notesFilePath = path.join(userDataPath, 'notes.json');
        this.notes = this.loadNotes();
    }

    loadNotes() {
        try {
            if (!fs.existsSync(this.notesFilePath)) { return []; }
            const data = fs.readFileSync(this.notesFilePath, 'utf8');
            return JSON.parse(data);
        } catch (error) {
            console.error('Error loading notes:', error);
            return [];
        }
    }

    saveNotes() {
        try {
            const data = JSON.stringify(this.notes, null, 2);
            fs.writeFileSync(this.notesFilePath, data, 'utf8');
        } catch (error) {
            console.error('Error saving notes:', error);
        }
    }

    addNote(problemName, code, results) {
        const newNote = {
            problemName: problemName,
            timestamp: new Date().toISOString(),
            code: code,
            results: results,
            aiAnalysis: null // AI 분석 결과를 저장할 필드 추가
        };
        this.notes.push(newNote);
        this.saveNotes();
    }
    
    // [추가] AI 분석 결과를 저장하는 메서드
    saveAiAnalysis(timestamp, aiAnalysis) {
        const noteIndex = this.notes.findIndex(note => note.timestamp === timestamp);
        if (noteIndex !== -1) {
            // 기존 노트 객체에 aiAnalysis 필드 추가/업데이트
            this.notes[noteIndex].aiAnalysis = aiAnalysis;
            this.saveNotes();
            console.log(`AI analysis saved for note ${timestamp}.`);
        } else {
            console.error(`Note with timestamp ${timestamp} not found for AI analysis save.`);
        }
    }

    getNotes(problemName) {
        return this.notes
            .filter(note => note.problemName === problemName)
            .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    }

    // 모든 오답 노트를 가져오는 함수
    getAllNotes() {
        return this.notes;
    }

    deleteNote(timestamp) {
        this.notes = this.notes.filter(note => note.timestamp !== timestamp);
        this.saveNotes();
        console.log(`Note with timestamp ${timestamp} deleted.`);
    }
}

async function createNoteManager() {
    const userDataPath = await ipcRenderer.invoke('get-user-data-path');
    return new NoteManager(userDataPath);
=======
    constructor(userDataPath) {
        this.notesFilePath = path.join(userDataPath, 'notes.json');
        this.notes = this.loadNotes();
    }

    loadNotes() {
        try {
            if (!fs.existsSync(this.notesFilePath)) { return []; }
            const data = fs.readFileSync(this.notesFilePath, 'utf8');
            return JSON.parse(data);
        } catch (error) {
            console.error('Error loading notes:', error);
            return [];
        }
    }

    saveNotes() {
        try {
            const data = JSON.stringify(this.notes, null, 2);
            fs.writeFileSync(this.notesFilePath, data, 'utf8');
        } catch (error) {
            console.error('Error saving notes:', error);
        }
    }

    addNote(problemName, code, results) {
        const newNote = {
            problemName: problemName,
            timestamp: new Date().toISOString(),
            code: code,
            results: results
        };
        this.notes.push(newNote);
        this.saveNotes();
    }

    getNotes(problemName) {
        return this.notes
            .filter(note => note.problemName === problemName)
            .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    }

    // 모든 오답 노트를 가져오는 함수
    getAllNotes() {
        return this.notes;
    }

    deleteNote(timestamp) {
        this.notes = this.notes.filter(note => note.timestamp !== timestamp);
        this.saveNotes();
        console.log(`Note with timestamp ${timestamp} deleted.`);
    }
}

async function createNoteManager() {
    const userDataPath = await ipcRenderer.invoke('get-user-data-path');
    return new NoteManager(userDataPath);
>>>>>>> 176a13f73a780469acb8a925d3e92ca89fd63af8
}

module.exports = createNoteManager;