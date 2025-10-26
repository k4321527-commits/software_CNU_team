const path = require('path');
const fs = require('fs');
const { ipcRenderer } = require('electron');

class NoteManager {
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
}

module.exports = createNoteManager;