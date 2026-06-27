import React, { useState, useEffect, useRef } from 'react';
import { jsPDF } from 'jspdf';
import { initializeApp } from 'firebase/app';
import { getFirestore, doc, setDoc, getDoc, serverTimestamp } from 'firebase/firestore';
import firebaseConfig from './firebase-applet-config.json';
import './index.css';

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

interface Note {
  id: string;
  title: string;
  rawTranscription: string;
  polishedNote: string;
  timestamp: number;
  tags: string[];
}

interface AppState {
  title: string;
  raw: string;
  polished: string;
  tags: string[];
}

export default function App() {
  // App States
  const [currentNote, setCurrentNote] = useState<Note | null>(null);
  const [activeTab, setActiveTab] = useState<'polished' | 'raw'>('polished');
  const [isRecording, setIsRecording] = useState(false);
  const [recordingStatus, setRecordingStatus] = useState('Ready to record');
  const [timerText, setTimerText] = useState('00:00.00');
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [historySearch, setHistorySearch] = useState('');
  const [activeFilterTags, setActiveFilterTags] = useState<Set<string>>(new Set());
  const [historyNotes, setHistoryNotes] = useState<Note[]>([]);
  const [tagInputText, setTagInputText] = useState('');
  const [isSharedView, setIsSharedView] = useState(false);
  const [hasSharedSaveButton, setHasSharedSaveButton] = useState(false);

  // Playback states
  const [lastRecordedAudio, setLastRecordedAudio] = useState<Blob | null>(null);
  const [isOriginalPlaying, setIsOriginalPlaying] = useState(false);
  const [isTtsPlaying, setIsTtsPlaying] = useState(false);

  // Refs
  const titleRef = useRef<HTMLDivElement>(null);
  const polishedRef = useRef<HTMLDivElement>(null);
  const rawRef = useRef<HTMLDivElement>(null);
  const polishedTabRef = useRef<HTMLButtonElement>(null);
  const rawTabRef = useRef<HTMLButtonElement>(null);
  const [indicatorStyle, setIndicatorStyle] = useState<React.CSSProperties>({});
  const [windowWidth, setWindowWidth] = useState(typeof window !== 'undefined' ? window.innerWidth : 0);

  // Handle window resizing to recalculate tab sizes
  useEffect(() => {
    const handleResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Update tab indicator style dynamically based on active tab dimensions
  useEffect(() => {
    const activeBtn = activeTab === 'polished' ? polishedTabRef.current : rawTabRef.current;
    if (activeBtn) {
      setIndicatorStyle({
        left: `${activeBtn.offsetLeft}px`,
        width: `${activeBtn.offsetWidth}px`,
        transition: 'all 0.3s cubic-bezier(0.25, 0.46, 0.45, 0.94)'
      });
    }
  }, [activeTab, windowWidth]);
  
  // Audio API Refs
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserNodeRef = useRef<AnalyserNode | null>(null);
  const animationFrameIdRef = useRef<number | null>(null);
  const timerIntervalRef = useRef<number | null>(null);
  const recordingStartTimeRef = useRef<number>(0);
  
  // Audio elements for playback
  const playbackAudioRef = useRef<HTMLAudioElement | null>(null);
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null);

  // Undo / Redo Refs & State
  const undoStackRef = useRef<AppState[]>([]);
  const redoStackRef = useRef<AppState[]>([]);
  const isPushingToStackRef = useRef(false);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  // Auto-save Ref
  const autoSaveTimeoutRef = useRef<number | null>(null);
  const hasUnsavedChangesRef = useRef(false);

  // Initialize App State
  useEffect(() => {
    // 1. Initialize Theme
    const savedTheme = localStorage.getItem('theme') || 'dark';
    setTheme(savedTheme as 'dark' | 'light');
    if (savedTheme === 'light') {
      document.body.classList.add('light-mode');
    } else {
      document.body.classList.remove('light-mode');
    }

    // 2. Load History
    loadHistoryFromStorage();

    // 3. Check for Shared Note or Restore Draft
    initializeAppState();

    // Unregister service workers as clean up
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistrations().then((registrations) => {
        for (const reg of registrations) {
          reg.unregister();
        }
      });
    }

    // Unload Confirmation
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (hasUnsavedChangesRef.current) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);

    // Keyboard Shortcuts
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
        e.preventDefault();
        triggerUndo();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'y') {
        e.preventDefault();
        triggerRedo();
      }
    };
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      window.removeEventListener('keydown', handleKeyDown);
      if (autoSaveTimeoutRef.current) clearTimeout(autoSaveTimeoutRef.current);
      if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
      if (animationFrameIdRef.current) cancelAnimationFrame(animationFrameIdRef.current);
      cleanupAudioContext();
    };
  }, []);

  // Update undo/redo buttons state
  const updateUndoRedoButtons = () => {
    setCanUndo(undoStackRef.current.length > 1);
    setCanRedo(redoStackRef.current.length > 0);
  };

  const cleanupAudioContext = () => {
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      audioContextRef.current.close().catch(console.error);
    }
    audioContextRef.current = null;
    analyserNodeRef.current = null;
  };

  const loadHistoryFromStorage = () => {
    const historyJson = localStorage.getItem('notes_history');
    const historyList = historyJson ? JSON.parse(historyJson) : [];
    setHistoryNotes(historyList);
  };

  const getHistory = (): Note[] => {
    const historyJson = localStorage.getItem('notes_history');
    return historyJson ? JSON.parse(historyJson) : [];
  };

  const initializeAppState = async () => {
    const params = new URLSearchParams(window.location.search);
    const shareId = params.get('share');

    if (shareId) {
      setIsSharedView(true);
      document.body.classList.add('shared-view');
      setRecordingStatus('Loading shared note...');

      try {
        const noteRef = doc(db, 'sharedNotes', shareId);
        const noteSnap = await getDoc(noteRef);

        if (noteSnap.exists()) {
          const data = noteSnap.data();
          const loadedNote: Note = {
            id: 'shared',
            title: data.title || 'Shared Note',
            rawTranscription: '',
            polishedNote: data.polishedNote || '',
            timestamp: data.timestamp || Date.now(),
            tags: data.tags || []
          };

          setCurrentNote(loadedNote);
          setHasSharedSaveButton(true);

          if (titleRef.current) titleRef.current.textContent = loadedNote.title;
          if (polishedRef.current) polishedRef.current.innerHTML = loadedNote.polishedNote;
          if (rawRef.current) rawRef.current.textContent = '';
          
          setRecordingStatus('Viewing shared note (Editable)');
        } else {
          setRecordingStatus('Shared note not found');
          if (polishedRef.current) {
            polishedRef.current.innerHTML = '<h1>Note Not Found</h1><p>The shared note you are looking for does not exist or has been removed.</p>';
          }
        }
      } catch (err) {
        console.error('Error loading shared note:', err);
        setRecordingStatus('Error loading shared note');
      }
    } else {
      const restored = restoreDraft();
      if (!restored) {
        createNewNote();
      }
    }
  };

  const createNewNote = () => {
    undoStackRef.current = [];
    redoStackRef.current = [];
    updateUndoRedoButtons();

    const newNote: Note = {
      id: `note_${Date.now()}`,
      title: 'Untitled Note',
      rawTranscription: '',
      polishedNote: '',
      timestamp: Date.now(),
      tags: [],
    };

    setCurrentNote(newNote);
    setLastRecordedAudio(null);
    stopPlayback();
    stopTtsPlayback();

    if (titleRef.current) titleRef.current.textContent = 'Untitled Note';
    if (rawRef.current) rawRef.current.textContent = '';
    if (polishedRef.current) polishedRef.current.innerHTML = '';

    setRecordingStatus('Ready to record');

    if (isRecording) {
      stopRecordingAction();
    }

    pushToUndoStack(newNote.title, '', '', []);
  };

  // State undo/redo
  const pushToUndoStack = (title: string, raw: string, polished: string, tags: string[]) => {
    if (isPushingToStackRef.current) return;

    const currentState: AppState = { title, raw, polished, tags };

    if (undoStackRef.current.length > 0) {
      const last = undoStackRef.current[undoStackRef.current.length - 1];
      if (
        last.title === currentState.title &&
        last.raw === currentState.raw &&
        last.polished === currentState.polished &&
        JSON.stringify(last.tags) === JSON.stringify(currentState.tags)
      ) {
        return;
      }
    }

    undoStackRef.current.push(currentState);
    if (undoStackRef.current.length > 50) undoStackRef.current.shift();
    redoStackRef.current = [];
    updateUndoRedoButtons();
  };

  const triggerUndo = () => {
    if (undoStackRef.current.length <= 1) return;

    isPushingToStackRef.current = true;
    const current = undoStackRef.current.pop()!;
    redoStackRef.current.push(current);

    const prev = undoStackRef.current[undoStackRef.current.length - 1];
    applyState(prev);

    isPushingToStackRef.current = false;
    updateUndoRedoButtons();
  };

  const triggerRedo = () => {
    if (redoStackRef.current.length === 0) return;

    isPushingToStackRef.current = true;
    const state = redoStackRef.current.pop()!;
    undoStackRef.current.push(state);

    applyState(state);

    isPushingToStackRef.current = false;
    updateUndoRedoButtons();
  };

  const applyState = (state: AppState) => {
    if (titleRef.current) titleRef.current.textContent = state.title || 'Untitled Note';
    if (rawRef.current) rawRef.current.textContent = state.raw;
    if (polishedRef.current) polishedRef.current.innerHTML = state.polished;

    setCurrentNote((prev) => {
      if (!prev) return null;
      const updated = {
        ...prev,
        title: state.title,
        rawTranscription: state.raw,
        polishedNote: state.polished,
        tags: [...state.tags]
      };
      saveCurrentNoteToHistoryDirect(updated, true);
      return updated;
    });
  };

  const debouncedHistoryPush = () => {
    const title = titleRef.current?.textContent?.trim() || 'Untitled Note';
    const raw = rawRef.current?.textContent || '';
    const polished = polishedRef.current?.innerHTML || '';
    const tags = currentNote?.tags || [];
    pushToUndoStack(title, raw, polished, tags);
  };

  // Draft lifecycle
  const saveDraft = (noteToSave: Note) => {
    const title = titleRef.current?.textContent?.trim() || '';
    const raw = rawRef.current?.textContent || '';
    const polished = polishedRef.current?.innerHTML || '';
    
    const draft = {
      title,
      rawTranscription: raw,
      polishedNote: polished,
      tags: noteToSave.tags
    };

    localStorage.setItem('notes_draft', JSON.stringify(draft));
  };

  const restoreDraft = (): boolean => {
    const draftStr = localStorage.getItem('notes_draft');
    if (!draftStr) return false;

    try {
      const draft = JSON.parse(draftStr);
      if (!draft.rawTranscription && !draft.polishedNote && !draft.title) return false;

      const title = draft.title || 'Untitled Note';
      const raw = draft.rawTranscription || '';
      const polished = draft.polishedNote || '';
      const tags = draft.tags || [];

      if (titleRef.current) titleRef.current.textContent = title;
      if (rawRef.current) rawRef.current.textContent = raw;
      if (polishedRef.current) polishedRef.current.innerHTML = polished;

      const restored: Note = {
        id: `draft_${Date.now()}`,
        title,
        rawTranscription: raw,
        polishedNote: polished,
        timestamp: Date.now(),
        tags
      };

      setCurrentNote(restored);
      pushToUndoStack(title, raw, polished, tags);

      // Show toast
      const toast = document.getElementById('draftToast');
      if (toast) {
        toast.classList.add('show');
        setTimeout(() => toast.classList.remove('show'), 5000);
      }
      return true;
    } catch (e) {
      console.error('Error restoring draft:', e);
      return false;
    }
  };

  const clearDraft = () => {
    localStorage.removeItem('notes_draft');
  };

  // Audio Recording Visualizer Logic
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const startRecording = async () => {
    try {
      audioChunksRef.current = [];
      setLastRecordedAudio(null);
      stopPlayback();
      stopTtsPlayback();

      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
      }
      cleanupAudioContext();

      setRecordingStatus('Requesting microphone access...');

      let userStream: MediaStream;
      try {
        userStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (err) {
        console.error('Microphone access denied or error:', err);
        userStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          },
        });
      }

      streamRef.current = userStream;

      let recorder: MediaRecorder;
      try {
        recorder = new MediaRecorder(userStream, { mimeType: 'audio/webm' });
      } catch (e) {
        console.warn('audio/webm not supported, trying default browser MediaRecorder:', e);
        recorder = new MediaRecorder(userStream);
      }

      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      recorder.onstop = () => {
        stopLiveDisplay();

        if (audioChunksRef.current.length > 0) {
          const audioBlob = new Blob(audioChunksRef.current, {
            type: recorder.mimeType || 'audio/webm',
          });
          processAudio(audioBlob);
        } else {
          setRecordingStatus('No audio data captured. Please try again.');
        }

        if (streamRef.current) {
          streamRef.current.getTracks().forEach((track) => track.stop());
          streamRef.current = null;
        }
      };

      recorder.start();
      setIsRecording(true);
      setRecordingStatus('Recording...');
      startLiveDisplay(userStream);
    } catch (error: any) {
      console.error('Error starting recording:', error);
      const name = error.name || 'Unknown';
      const msg = error.message || '';

      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        setRecordingStatus('Microphone permission denied. Please allow microphone access and reload.');
      } else if (name === 'NotFoundError') {
        setRecordingStatus('No microphone found. Please connect a microphone.');
      } else if (name === 'NotReadableError' || msg.includes('Failed to allocate audiosource')) {
        setRecordingStatus('Microphone is in use by another application.');
      } else {
        setRecordingStatus(`Error: ${msg || name}`);
      }
      setIsRecording(false);
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
      }
      stopLiveDisplay();
    }
  };

  const stopRecordingAction = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      try {
        mediaRecorderRef.current.stop();
      } catch (e) {
        console.error('Error stopping recorder:', e);
        stopLiveDisplay();
      }
      setIsRecording(false);
      setRecordingStatus('Processing audio...');
    }
  };

  const startLiveDisplay = (stream: MediaStream) => {
    setupCanvasDimensions();

    // Setup Analyser
    audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
    const source = audioContextRef.current.createMediaStreamSource(stream);
    const analyser = audioContextRef.current.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.75;
    analyserNodeRef.current = analyser;

    source.connect(analyser);

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    // Draw Loop
    const draw = () => {
      if (!analyserNodeRef.current || !canvasRef.current) return;
      animationFrameIdRef.current = requestAnimationFrame(draw);

      analyserNodeRef.current.getByteFrequencyData(dataArray);

      const canvas = canvasRef.current;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      ctx.clearRect(0, 0, width, height);

      // Symmetrical rounded vertical bars
      const numBars = 45;
      const spacingWidth = width / numBars;
      const barWidth = Math.max(3, Math.floor(spacingWidth * 0.5));

      const textColor = getComputedStyle(document.documentElement).getPropertyValue('--color-text').trim() || '#ffffff';
      
      ctx.lineWidth = barWidth;
      ctx.lineCap = 'round';
      ctx.strokeStyle = textColor;

      const midY = height / 2;

      for (let i = 0; i < numBars; i++) {
        const dataIdx = Math.floor((i / numBars) * (bufferLength * 0.6));
        const amplitude = dataArray[dataIdx] / 255.0;
        
        const minHeight = 4;
        const maxHeight = height * 0.8;
        const barHeight = minHeight + (amplitude * (maxHeight - minHeight));
        
        const halfBar = barHeight / 2;
        const x = i * spacingWidth + barWidth / 2;
        const yStart = midY - halfBar;
        const yEnd = midY + halfBar;

        ctx.beginPath();
        ctx.moveTo(x, yStart);
        ctx.lineTo(x, yEnd);
        ctx.stroke();
      }
    };

    animationFrameIdRef.current = requestAnimationFrame(draw);

    // Timer Loop
    recordingStartTimeRef.current = Date.now();
    updateTimerText();
    timerIntervalRef.current = window.setInterval(updateTimerText, 50);
  };

  const stopLiveDisplay = () => {
    if (animationFrameIdRef.current) {
      cancelAnimationFrame(animationFrameIdRef.current);
      animationFrameIdRef.current = null;
    }
    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = null;
    }

    if (canvasRef.current) {
      const ctx = canvasRef.current.getContext('2d');
      ctx?.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
    }

    cleanupAudioContext();
  };

  const updateTimerText = () => {
    const elapsed = Date.now() - recordingStartTimeRef.current;
    const totalSeconds = Math.floor(elapsed / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    const hundredths = Math.floor((elapsed % 1000) / 10);
    setTimerText(
      `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(hundredths).padStart(2, '0')}`
    );
  };

  const adjustColor = (color: string, amount: number): string => {
    if (color.startsWith('#')) {
      const num = parseInt(color.slice(1), 16);
      let r = (num >> 16) + amount;
      let g = ((num >> 8) & 0x00FF) + amount;
      let b = (num & 0x0000FF) + amount;

      r = Math.max(0, Math.min(255, r));
      g = Math.max(0, Math.min(255, g));
      b = Math.max(0, Math.min(255, b));

      return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
    }
    return color;
  };

  const setupCanvasDimensions = () => {
    if (!canvasRef.current) return;
    const canvas = canvasRef.current;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();

    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    const ctx = canvas.getContext('2d');
    ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  // Process Recorded Audio File / Uploaded File
  const processAudio = async (audioBlob: Blob) => {
    if (audioBlob.size === 0) {
      setRecordingStatus('No audio data captured. Please try again.');
      return;
    }

    setLastRecordedAudio(audioBlob);

    try {
      setRecordingStatus('Processing transcription...');
      const reader = new FileReader();
      reader.onloadend = async () => {
        const base64Audio = (reader.result as string).split(',')[1];
        const mimeType = audioBlob.type || 'audio/webm';
        await getTranscription(base64Audio, mimeType);
      };
      reader.readAsDataURL(audioBlob);
    } catch (error) {
      console.error('Error handling audio blob:', error);
      setRecordingStatus('Error processing recording.');
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const file = files[0];
    setRecordingStatus(`Uploading ${file.name}...`);

    processAudio(file).then(() => {
      e.target.value = '';
    }).catch((err) => {
      console.error('File upload processing error:', err);
      setRecordingStatus('Error processing uploaded file');
    });
  };

  // API Integration (Whisper Transcription & Polishing)
  const getTranscription = async (base64Audio: string, mimeType: string) => {
    try {
      const response = await fetch('/api/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base64Audio, mimeType }),
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        const errMsg = errData.error || 'Server error during transcription.';
        console.error('Server transcription error:', errMsg);
        
        if (errMsg.includes('OPENAI_API_KEY')) {
          setRecordingStatus('Please configure your OpenAI API Key in the server .env file.');
        } else {
          setRecordingStatus(errMsg);
        }
        return;
      }

      const data = await response.json();
      const transcriptionText = data.transcription || '';

      if (rawRef.current) {
        rawRef.current.textContent = transcriptionText;
      }

      setCurrentNote((prev) => {
        if (!prev) return null;
        const updated = { ...prev, rawTranscription: transcriptionText };
        saveCurrentNoteToHistoryDirect(updated, true);
        return updated;
      });

      // Automatically trigger note polishing
      await getPolishedNote(transcriptionText);
    } catch (error) {
      console.error('Transcription error:', error);
      setRecordingStatus('Error during transcription. Please verify connection and API keys.');
    }
  };

  const getPolishedNote = async (rawContentText?: string) => {
    const rawToPolish = rawContentText || rawRef.current?.textContent || '';
    if (!rawToPolish.trim()) return;

    setRecordingStatus('Polishing note...');
    try {
      const response = await fetch('/api/polish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rawContent: rawToPolish }),
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        const errMsg = errData.error || 'Server error during note polishing.';
        console.error('Server polishing error:', errMsg);
        setRecordingStatus(errMsg);
        return;
      }

      const data = await response.json();
      const polishedText = data.polishedText || '';

      if (polishedRef.current) {
        polishedRef.current.innerHTML = polishedText;
      }

      setCurrentNote((prev) => {
        if (!prev) return null;
        const updated = { ...prev, polishedNote: polishedText };
        saveCurrentNoteToHistoryDirect(updated, true);
        return updated;
      });

      setRecordingStatus('Transcription complete and polished!');
    } catch (error) {
      console.error('Polishing note error:', error);
      setRecordingStatus('Error polishing note. Please verify connection.');
    }
  };

  // Original Audio Playback
  const togglePlayback = () => {
    if (!lastRecordedAudio) return;

    if (playbackAudioRef.current && !playbackAudioRef.current.paused) {
      playbackAudioRef.current.pause();
      setIsOriginalPlaying(false);
      return;
    }

    if (!playbackAudioRef.current) {
      const audioUrl = URL.createObjectURL(lastRecordedAudio);
      const audio = new Audio(audioUrl);
      audio.onended = () => {
        setIsOriginalPlaying(false);
      };
      playbackAudioRef.current = audio;
    }

    playbackAudioRef.current.play().catch(console.error);
    setIsOriginalPlaying(true);
  };

  const stopPlayback = () => {
    if (playbackAudioRef.current) {
      playbackAudioRef.current.pause();
      playbackAudioRef.current = null;
    }
    setIsOriginalPlaying(false);
  };

  // Text-To-Speech (TTS) Playback
  const toggleTtsPlayback = async () => {
    const textToSpeak = activeTab === 'polished' 
      ? polishedRef.current?.textContent || '' 
      : rawRef.current?.textContent || '';

    if (!textToSpeak.trim()) {
      setRecordingStatus('No text to speak.');
      return;
    }

    if (ttsAudioRef.current && !ttsAudioRef.current.paused) {
      ttsAudioRef.current.pause();
      setIsTtsPlaying(false);
      return;
    }

    if (ttsAudioRef.current) {
      ttsAudioRef.current.play().catch(console.error);
      setIsTtsPlaying(true);
      return;
    }

    setRecordingStatus('Synthesizing speech...');
    try {
      const response = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: textToSpeak }),
      });

      if (!response.ok) {
        throw new Error('TTS compilation failed');
      }

      const audioBlob = await response.blob();
      const audioUrl = URL.createObjectURL(audioBlob);
      const audio = new Audio(audioUrl);
      
      audio.onended = () => {
        setIsTtsPlaying(false);
      };

      ttsAudioRef.current = audio;
      audio.play().catch(console.error);
      setIsTtsPlaying(true);
      setRecordingStatus('Speaking note...');
    } catch (err) {
      console.error('TTS error:', err);
      setRecordingStatus('Error synthesizing text-to-speech.');
      setIsTtsPlaying(false);
    }
  };

  const stopTtsPlayback = () => {
    if (ttsAudioRef.current) {
      ttsAudioRef.current.pause();
      ttsAudioRef.current = null;
    }
    setIsTtsPlaying(false);
  };

  // Save/History Note CRUD
  const triggerManualSave = () => {
    if (!currentNote) return;
    saveCurrentNoteToHistoryDirect(currentNote, false);
  };

  const triggerAutoSave = () => {
    hasUnsavedChangesRef.current = true;
    if (autoSaveTimeoutRef.current) clearTimeout(autoSaveTimeoutRef.current);
    autoSaveTimeoutRef.current = window.setTimeout(() => {
      if (currentNote) {
        saveCurrentNoteToHistoryDirect(currentNote, true);
      }
    }, 3000);
  };

  const saveCurrentNoteToHistoryDirect = (note: Note, isAutoSave = false) => {
    const title = titleRef.current?.textContent?.trim() || 'Untitled Note';
    const rawContent = rawRef.current?.textContent || '';
    const polishedContent = polishedRef.current?.innerHTML || '';

    if (!isAutoSave && !rawContent && !polishedContent && title === 'Untitled Note') {
      setRecordingStatus('Nothing to save');
      return;
    }

    const updatedNote: Note = {
      ...note,
      title,
      rawTranscription: rawContent,
      polishedNote: polishedContent,
      timestamp: Date.now()
    };

    const history = getHistory();
    const existingIdx = history.findIndex((n) => n.id === updatedNote.id);

    if (existingIdx > -1) {
      history[existingIdx] = updatedNote;
    } else {
      history.unshift(updatedNote);
    }

    localStorage.setItem('notes_history', JSON.stringify(history));
    setHistoryNotes(history);

    if (isAutoSave) {
      hasUnsavedChangesRef.current = false;
      saveDraft(updatedNote);
    } else {
      hasUnsavedChangesRef.current = false;
      clearDraft();
      setRecordingStatus('Note saved to history');
    }
  };

  const deleteNote = (id: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    let history = getHistory();
    history = history.filter((n) => n.id !== id);
    localStorage.setItem('notes_history', JSON.stringify(history));
    setHistoryNotes(history);

    if (currentNote?.id === id) {
      createNewNote();
    }
  };

  const clearAllHistory = () => {
    if (historyNotes.length === 0) return;
    if (window.confirm('Are you sure you want to clear your entire note history? This action cannot be undone.')) {
      localStorage.removeItem('notes_history');
      setHistoryNotes([]);
      createNewNote();
      setRecordingStatus('Note history cleared');
    }
  };

  const loadNote = (note: Note) => {
    undoStackRef.current = [];
    redoStackRef.current = [];
    updateUndoRedoButtons();

    setCurrentNote({ ...note, tags: note.tags || [] });
    setLastRecordedAudio(null);
    stopPlayback();
    stopTtsPlayback();

    if (titleRef.current) titleRef.current.textContent = note.title || 'Untitled Note';
    if (rawRef.current) rawRef.current.textContent = note.rawTranscription || '';
    if (polishedRef.current) polishedRef.current.innerHTML = note.polishedNote || '';

    setRecordingStatus('Note loaded from history');
    pushToUndoStack(note.title, note.rawTranscription, note.polishedNote, note.tags);
  };

  // Tags
  const addTag = (tag: string) => {
    if (!currentNote) return;
    const cleanTag = tag.trim().toLowerCase();
    if (cleanTag && !currentNote.tags.includes(cleanTag)) {
      const updatedTags = [...currentNote.tags, cleanTag];
      const updatedNote = { ...currentNote, tags: updatedTags };
      setCurrentNote(updatedNote);
      saveCurrentNoteToHistoryDirect(updatedNote, true);
      debouncedHistoryPush();
    }
  };

  const removeTag = (tag: string) => {
    if (!currentNote) return;
    const updatedTags = currentNote.tags.filter((t) => t !== tag);
    const updatedNote = { ...currentNote, tags: updatedTags };
    setCurrentNote(updatedNote);
    saveCurrentNoteToHistoryDirect(updatedNote, true);
    debouncedHistoryPush();
  };

  // Export Note functions
  const exportTxt = () => {
    if (!currentNote) return;
    const title = titleRef.current?.textContent?.trim() || 'Untitled Note';
    const rawContent = rawRef.current?.textContent || '';
    const polishedContent = stripHtml(polishedRef.current?.innerHTML || '');

    const content = `TITLE: ${title}\nDATE: ${new Date(currentNote.timestamp).toLocaleString()}\nTAGS: ${currentNote.tags.join(', ')}\n\n--- POLISHED NOTE ---\n${polishedContent}\n\n--- RAW TRANSCRIPTION ---\n${rawContent}`;

    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${title.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    setRecordingStatus('Note exported as .txt');
  };

  const exportPdf = () => {
    if (!currentNote) return;
    const title = titleRef.current?.textContent?.trim() || 'Untitled Note';
    const rawContent = rawRef.current?.textContent || '';
    const polishedContent = stripHtml(polishedRef.current?.innerHTML || '');

    const pdfDoc = new jsPDF();
    const margin = 10;
    const pageWidth = pdfDoc.internal.pageSize.width;
    const contentWidth = pageWidth - 2 * margin;

    pdfDoc.setFontSize(18);
    pdfDoc.text(title, margin, 20);

    pdfDoc.setFontSize(10);
    pdfDoc.setTextColor(100);
    pdfDoc.text(`Date: ${new Date(currentNote.timestamp).toLocaleString()}`, margin, 30);
    pdfDoc.text(`Tags: ${currentNote.tags.join(', ')}`, margin, 35);

    let currentY = 45;

    pdfDoc.setFontSize(14);
    pdfDoc.setTextColor(0);
    pdfDoc.text('Polished Note', margin, currentY);
    currentY += 10;

    pdfDoc.setFontSize(11);
    const polishedLines = pdfDoc.splitTextToSize(polishedContent, contentWidth);
    pdfDoc.text(polishedLines, margin, currentY);
    currentY += (polishedLines.length * 7) + 10;

    if (currentY > 250) {
      pdfDoc.addPage();
      currentY = 20;
    }

    pdfDoc.setFontSize(14);
    pdfDoc.text('Raw Transcription', margin, currentY);
    currentY += 10;

    pdfDoc.setFontSize(10);
    pdfDoc.setTextColor(100);
    const rawLines = pdfDoc.splitTextToSize(rawContent, contentWidth);
    pdfDoc.text(rawLines, margin, currentY);

    pdfDoc.save(`${title.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.pdf`);
    setRecordingStatus('Note exported as .pdf');
  };

  const stripHtml = (html: string): string => {
    const tmp = document.createElement('DIV');
    tmp.innerHTML = html;
    return tmp.textContent || tmp.innerText || '';
  };

  // Firebase Share Notes
  const shareNote = async () => {
    if (!currentNote) return;

    saveDraft(currentNote);

    const title = titleRef.current?.textContent?.trim() || 'Untitled Note';
    const polishedContent = polishedRef.current?.innerHTML || '';

    if (!polishedContent) {
      setRecordingStatus('Nothing to share - please transcribe first');
      return;
    }

    setRecordingStatus('Generating share link...');

    try {
      const noteId = `share_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
      const sharedNoteRef = doc(db, 'sharedNotes', noteId);

      const sharedData = {
        title: title,
        polishedNote: polishedContent,
        tags: currentNote.tags,
        timestamp: Date.now(),
        createdAt: serverTimestamp()
      };

      await setDoc(sharedNoteRef, sharedData);

      const shareUrl = `${window.location.origin}${window.location.pathname}?share=${noteId}`;
      await navigator.clipboard.writeText(shareUrl);

      // Show toast
      const toast = document.getElementById('shareToast');
      if (toast) {
        toast.classList.add('show');
        setTimeout(() => toast.classList.remove('show'), 3000);
      }

      setRecordingStatus('Share link copied to clipboard!');
    } catch (err) {
      console.error('Error sharing note:', err);
      setRecordingStatus('Error generating share link');
    }
  };

  const saveSharedToLocal = () => {
    if (!currentNote) return;

    const notesHistory = getHistory();
    const newNote = { ...currentNote, id: `note_${Date.now()}` };
    notesHistory.unshift(newNote);
    localStorage.setItem('notes_history', JSON.stringify(notesHistory));

    setRecordingStatus('Note saved to your history!');
    setHasSharedSaveButton(false);

    setTimeout(() => {
      window.location.href = window.location.origin + window.location.pathname;
    }, 1500);
  };

  // Theme Management
  const toggleTheme = () => {
    const nextTheme = theme === 'dark' ? 'light' : 'dark';
    setTheme(nextTheme);
    localStorage.setItem('theme', nextTheme);
    if (nextTheme === 'light') {
      document.body.classList.add('light-mode');
    } else {
      document.body.classList.remove('light-mode');
    }
  };

  // Filter & Search Logic for History Sidebar
  const getUniqueTagsFromHistory = (): string[] => {
    const tags = new Set<string>();
    historyNotes.forEach(note => note.tags?.forEach(t => tags.add(t)));
    return Array.from(tags);
  };

  const toggleFilterTag = (tag: string) => {
    const updated = new Set(activeFilterTags);
    if (updated.has(tag)) {
      updated.delete(tag);
    } else {
      updated.add(tag);
    }
    setActiveFilterTags(updated);
  };

  const filteredHistoryNotes = historyNotes.filter((note) => {
    const q = historySearch.toLowerCase();
    const matchesSearch = 
      note.title.toLowerCase().includes(q) ||
      note.rawTranscription.toLowerCase().includes(q) ||
      note.polishedNote.toLowerCase().includes(q);

    const matchesTags = 
      activeFilterTags.size === 0 ||
      (note.tags && Array.from(activeFilterTags).every(tag => note.tags.includes(tag)));

    return matchesSearch && matchesTags;
  });

  return (
    <div className="app-container">
      <div className="main-content">
        <div className="note-area">
          <div className="note-header">
            <div 
              ref={titleRef}
              className="editor-title" 
              id="editorTitle" 
              contentEditable="true"
              suppressContentEditableWarning={true}
              placeholder="Untitled Note"
              onInput={triggerAutoSave}
              onBlur={debouncedHistoryPush}
            >
              Untitled Note
            </div>
            
            <div className="header-actions-container">
              <div className="tab-navigation-container">
                <div className="tab-navigation">
                   <button 
                    ref={polishedTabRef}
                    className={`tab-button ${activeTab === 'polished' ? 'active' : ''}`}
                    onClick={() => setActiveTab('polished')}
                  >
                    Polished
                  </button>
                  <button 
                    ref={rawTabRef}
                    className={`tab-button ${activeTab === 'raw' ? 'active' : ''}`}
                    onClick={() => setActiveTab('raw')}
                  >
                    Raw
                  </button>
                  <div 
                    className="active-tab-indicator"
                    style={indicatorStyle}
                  />
                </div>
              </div>
              
              <div className="utility-actions">
                <div className="export-dropdown">
                  <button className="header-action-btn" id="exportButton" title="Export Note">
                    <i className="fas fa-download"></i>
                  </button>
                  <div className="export-menu">
                    <button onClick={exportTxt}>Text (.txt)</button>
                    <button onClick={exportPdf}>PDF (.pdf)</button>
                  </div>
                </div>
                <button 
                  className="header-action-btn" 
                  onClick={createNewNote}
                  title="New Note (Duplicate)"
                >
                  <i className="fas fa-copy"></i>
                </button>
                <button 
                  className="header-action-btn" 
                  disabled={!canUndo} 
                  onClick={triggerUndo}
                  title="Undo (Ctrl+Z)"
                >
                  <i className="fas fa-undo"></i>
                </button>
                <button 
                  className="header-action-btn" 
                  disabled={!canRedo} 
                  onClick={triggerRedo}
                  title="Redo (Ctrl+Y)"
                >
                  <i className="fas fa-redo"></i>
                </button>
                {hasSharedSaveButton && (
                  <button 
                    className="header-action-btn" 
                    onClick={saveSharedToLocal}
                    title="Save to My Notes"
                  >
                    <i className="fas fa-save"></i>
                  </button>
                )}
                <button 
                  className="header-action-btn" 
                  onClick={shareNote}
                  title="Share Note"
                >
                  <i className="fas fa-share-alt"></i>
                </button>
                <button 
                  className="header-action-btn" 
                  onClick={() => setIsHistoryOpen(true)}
                  title="History"
                >
                  <i className="fas fa-history"></i>
                </button>
              </div>
            </div>
          </div>

          <div className="tag-input-wrapper-main">
            <div className="tag-chips-input-container">
              <div id="currentTags" className="tag-chips">
                {currentNote?.tags.map((tag) => (
                  <div className="tag-chip" key={tag}>
                    <span>{tag}</span>
                    <i className="fas fa-times remove-tag" onClick={() => removeTag(tag)}></i>
                  </div>
                ))}
              </div>
              <input 
                type="text" 
                id="tagInput" 
                placeholder="Add tags..." 
                className="tag-input"
                value={tagInputText}
                onChange={(e) => setTagInputText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    addTag(tagInputText);
                    setTagInputText('');
                  }
                }}
              />
            </div>
          </div>

          <div className="note-content-wrapper">
            <div
              ref={polishedRef}
              id="polishedNote"
              className={`note-content ${activeTab === 'polished' ? 'active' : ''}`}
              contentEditable="true"
              suppressContentEditableWarning={true}
              placeholder="Your polished notes will appear here..."
              onInput={triggerAutoSave}
              onBlur={debouncedHistoryPush}
            />
            <div
              ref={rawRef}
              id="rawTranscription"
              className={`note-content ${activeTab === 'raw' ? 'active' : ''}`}
              contentEditable="true"
              suppressContentEditableWarning={true}
              placeholder="Raw transcription will appear here..."
              onInput={triggerAutoSave}
              onBlur={debouncedHistoryPush}
            />
          </div>
        </div>

        <div className={`recording-interface ${isRecording ? 'is-live' : ''}`}>
          {isRecording && (
            <div id="liveRecordingTitle" className="live-recording-title">
              {titleRef.current?.textContent?.trim() !== 'Untitled Note' ? titleRef.current?.textContent : 'New Recording'}
            </div>
          )}
          <canvas 
            ref={canvasRef}
            id="liveWaveformCanvas" 
            style={{ display: isRecording ? 'block' : 'none' }}
          />
          {isRecording && (
            <div id="liveRecordingTimerDisplay" className="live-recording-timer">
              {timerText}
            </div>
          )}

          {!isRecording && (
            <div className="status-indicator">
              <span id="recordingStatus" className="status-text">{recordingStatus}</span>
            </div>
          )}

          <div className="recording-controls">
            <button className="action-button" onClick={toggleTheme} title="Toggle Theme">
              <i className={`fas ${theme === 'dark' ? 'fa-sun' : 'fa-moon'}`}></i>
              <span className="action-btn-text">Theme</span>
            </button>

            <button className="action-button" onClick={() => document.getElementById('audioUploadInput')?.click()} title="Upload Audio">
              <i className="fas fa-upload"></i>
              <span className="action-btn-text">Upload</span>
            </button>
            <input 
              type="file" 
              id="audioUploadInput" 
              accept="audio/*" 
              style={{ display: 'none' }}
              onChange={handleFileUpload}
            />

            {lastRecordedAudio && (
              <button 
                className="action-button"
                onClick={togglePlayback} 
                title="Listen to Original Recording"
              >
                <i className={`fas ${isOriginalPlaying ? 'fa-pause' : 'fa-play'}`}></i>
                <span className="action-btn-text">{isOriginalPlaying ? 'Pause' : 'Listen'}</span>
              </button>
            )}

            {/* Read Aloud TTS button! */}
            <button 
              className={`action-button ${(currentNote?.rawTranscription || currentNote?.polishedNote) ? '' : 'hidden'}`}
              onClick={toggleTtsPlayback}
              title="Read Aloud (AI Voice)"
            >
              <i className={`fas ${isTtsPlaying ? 'fa-pause' : 'fa-volume-up'}`}></i>
              <span className="action-btn-text">{isTtsPlaying ? 'Stop' : 'Speak'}</span>
            </button>

            <button 
              id="recordButton" 
              className={`record-button ${isRecording ? 'recording' : ''}`} 
              onClick={isRecording ? stopRecordingAction : startRecording}
              title={isRecording ? 'Stop Recording' : 'Start Recording'}
            >
              <div className="record-button-inner">
                <i className={`fas ${isRecording ? 'fa-stop' : 'fa-microphone'}`}></i>
              </div>
              <svg className="record-waves" viewBox="0 0 200 200">
                <circle className="wave wave1" cx="100" cy="100" r="40" />
                <circle className="wave wave2" cx="100" cy="100" r="70" />
                <circle className="wave wave3" cx="100" cy="100" r="100" />
              </svg>
              <span className="record-text">{isRecording ? 'Stop' : 'Record'}</span>
            </button>

            <button className="action-button" onClick={createNewNote} title="New Note">
              <i className="fas fa-plus"></i>
              <span className="action-btn-text">New</span>
            </button>
          </div>
        </div>
      </div>

      {/* History Sidebar */}
      <div id="historySidebar" className={`history-sidebar ${isHistoryOpen ? 'open' : ''}`}>
        <div className="sidebar-header">
          <h3>History</h3>
          <div className="sidebar-header-actions">
            <button onClick={clearAllHistory} className="clear-history-btn" title="Clear all history">
              <i className="fas fa-trash-sweep"></i>
            </button>
            <button onClick={() => setIsHistoryOpen(false)} className="close-sidebar-btn">
              <i className="fas fa-times"></i>
            </button>
          </div>
        </div>
        <div className="sidebar-search-area">
          <div className="search-box">
            <i className="fas fa-search"></i>
            <input 
              type="text" 
              placeholder="Search titles or content..."
              value={historySearch}
              onChange={(e) => setHistorySearch(e.target.value)}
            />
          </div>
          <div id="filterTags" className="filter-tags-list">
            {getUniqueTagsFromHistory().map(tag => (
              <div 
                key={tag} 
                className={`filter-tag ${activeFilterTags.has(tag) ? 'active' : ''}`}
                onClick={() => toggleFilterTag(tag)}
              >
                {tag}
              </div>
            ))}
          </div>
        </div>
        <div id="historyList" className="history-list">
          {filteredHistoryNotes.length === 0 ? (
            <div className="history-empty-message">No matching notes found</div>
          ) : (
            filteredHistoryNotes.map((note) => (
              <div 
                className="history-item" 
                key={note.id}
                onClick={() => {
                  loadNote(note);
                  setIsHistoryOpen(false);
                }}
              >
                <div className="history-item-left">
                  <div className="history-item-status">
                    <span className={`status-dot ${note.polishedNote || note.rawTranscription ? 'transcribed' : 'draft'}`}></span>
                    <span className="status-label">
                      {note.polishedNote || note.rawTranscription ? 'Transcribed' : 'Draft'}
                    </span>
                  </div>
                  <div className="history-item-title">{note.title || 'Untitled Note'}</div>
                  <div className="history-item-date">
                    {new Date(note.timestamp).toLocaleDateString(undefined, { 
                      month: 'short', 
                      day: 'numeric', 
                      year: 'numeric' 
                    })} at {new Date(note.timestamp).toLocaleTimeString(undefined, { 
                      hour: 'numeric', 
                      minute: '2-digit' 
                    })}
                  </div>
                </div>
                <div className="history-item-right">
                  <button 
                    className="delete-history-btn" 
                    onClick={(e) => deleteNote(note.id, e)}
                    title="Delete Note"
                  >
                    <i className="fas fa-trash-can"></i>
                  </button>
                  <i className="fas fa-chevron-right history-chevron"></i>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
      <div 
        className={`sidebar-overlay ${isHistoryOpen ? 'active' : ''}`} 
        onClick={() => setIsHistoryOpen(false)}
      />

      {/* Toast Notification */}
      <div id="draftToast" className="share-toast draft-toast">
        <div className="share-toast-content">
          <i className="fas fa-file-alt"></i>
          <span>Restored unsaved changes from last session</span>
          <button 
            onClick={() => document.getElementById('draftToast')?.classList.remove('show')} 
            className="toast-action-btn"
          >
            Dismiss
          </button>
        </div>
      </div>

      <div id="shareToast" className="share-toast">
        <div className="share-toast-content">
          <i className="fas fa-link"></i>
          <span id="shareToastMessage">Link copied to clipboard!</span>
        </div>
      </div>
    </div>
  );
}
