/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
/* tslint:disable */

import {marked} from 'marked';
import {jsPDF} from 'jspdf';
import { initializeApp } from 'firebase/app';
import { getFirestore, doc, setDoc, getDoc, collection, serverTimestamp } from 'firebase/firestore';
import { GoogleGenAI } from "@google/genai";
import firebaseConfig from './firebase-applet-config.json';
import './index.css';

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

class VoiceNotesApp {
  private mediaRecorder: MediaRecorder | null = null;
  private recordButton: HTMLButtonElement;
  private recordingStatus: HTMLDivElement;
  private rawTranscription: HTMLDivElement;
  private polishedNote: HTMLDivElement;
  private newButton: HTMLButtonElement;
  private historyToggleButton: HTMLButtonElement;
  private closeHistoryButton: HTMLButtonElement;
  private historySidebar: HTMLDivElement;
  private sidebarOverlay: HTMLDivElement;
  private historyList: HTMLDivElement;
  private themeToggleButton: HTMLButtonElement;
  private themeToggleIcon: HTMLElement;
  private audioChunks: Blob[] = [];
  private isRecording = false;
  private currentNote: Note | null = null;
  private stream: MediaStream | null = null;
  private editorTitle: HTMLDivElement;
  private copyButton: HTMLButtonElement;
  private exportButton: HTMLButtonElement;
  private exportTxtButton: HTMLButtonElement;
  private exportPdfButton: HTMLButtonElement;
  private uploadButton: HTMLButtonElement;
  private audioUploadInput: HTMLInputElement;
  private shareButton: HTMLButtonElement;
  private undoButton: HTMLButtonElement;
  private redoButton: HTMLButtonElement;
  private playPlaybackButton: HTMLButtonElement;
  private saveSharedToLocalButton: HTMLButtonElement;
  private clearHistoryButton: HTMLButtonElement;
  private tagInput: HTMLInputElement;
  private currentTagsContainer: HTMLDivElement;
  private historySearch: HTMLInputElement;
  private filterTagsContainer: HTMLDivElement;
  private activeFilterTags: Set<string> = new Set();
  private hasUnsavedChanges = false;
  private autoSaveTimeout: number | null = null;
  private hasAttemptedPermission = false;
  private lastRecordedAudio: Blob | null = null;
  private playbackAudio: HTMLAudioElement | null = null;
  private undoStack: AppState[] = [];
  private redoStack: AppState[] = [];
  private isPushingToStack = false;
  private deferredPrompt: any = null;
  private installButton: HTMLButtonElement;

  private recordingInterface: HTMLDivElement;
  private liveRecordingTitle: HTMLDivElement;
  private liveWaveformCanvas: HTMLCanvasElement | null;
  private liveWaveformCtx: CanvasRenderingContext2D | null = null;
  private liveRecordingTimerDisplay: HTMLDivElement;
  private statusIndicatorDiv: HTMLDivElement | null;

  private audioContext: AudioContext | null = null;
  private analyserNode: AnalyserNode | null = null;
  private waveformDataArray: Uint8Array | null = null;
  private waveformDrawingId: number | null = null;
  private timerIntervalId: number | null = null;
  private recordingStartTime: number = 0;

  constructor() {
    this.recordButton = document.getElementById(
      'recordButton',
    ) as HTMLButtonElement;
    this.recordingStatus = document.getElementById(
      'recordingStatus',
    ) as HTMLDivElement;
    this.rawTranscription = document.getElementById(
      'rawTranscription',
    ) as HTMLDivElement;
    this.polishedNote = document.getElementById(
      'polishedNote',
    ) as HTMLDivElement;
    this.newButton = document.getElementById('newButton') as HTMLButtonElement;
    this.historyToggleButton = document.getElementById(
      'historyToggleButton',
    ) as HTMLButtonElement;
    this.closeHistoryButton = document.getElementById(
      'closeHistoryButton',
    ) as HTMLButtonElement;
    this.historySidebar = document.getElementById(
      'historySidebar',
    ) as HTMLDivElement;
    this.sidebarOverlay = document.getElementById(
      'sidebarOverlay',
    ) as HTMLDivElement;
    this.historyList = document.getElementById('historyList') as HTMLDivElement;

    this.themeToggleButton = document.getElementById(
      'themeToggleButton',
    ) as HTMLButtonElement;
    this.themeToggleIcon = this.themeToggleButton.querySelector(
      'i',
    ) as HTMLElement;
    this.editorTitle = document.getElementById(
      'editorTitle',
    ) as HTMLDivElement;
    this.copyButton = document.getElementById(
      'copyButton',
    ) as HTMLButtonElement;
    this.exportButton = document.getElementById(
      'exportButton',
    ) as HTMLButtonElement;
    this.exportTxtButton = document.getElementById(
      'exportTxt',
    ) as HTMLButtonElement;
    this.exportPdfButton = document.getElementById(
      'exportPdf',
    ) as HTMLButtonElement;
    this.uploadButton = document.getElementById(
      'uploadButton',
    ) as HTMLButtonElement;
    this.audioUploadInput = document.getElementById(
      'audioUploadInput',
    ) as HTMLInputElement;
    this.shareButton = document.getElementById(
      'shareButton',
    ) as HTMLButtonElement;
    this.undoButton = document.getElementById(
      'undoButton',
    ) as HTMLButtonElement;
    this.redoButton = document.getElementById(
      'redoButton',
    ) as HTMLButtonElement;
    this.installButton = document.getElementById(
      'installButton'
    ) as HTMLButtonElement;
    this.playPlaybackButton = document.getElementById(
      'playPlaybackButton',
    ) as HTMLButtonElement;
    this.saveSharedToLocalButton = document.getElementById(
      'saveSharedToLocalButton',
    ) as HTMLButtonElement;
    this.clearHistoryButton = document.getElementById(
      'clearHistoryButton',
    ) as HTMLButtonElement;
    this.tagInput = document.getElementById('tagInput') as HTMLInputElement;
    this.currentTagsContainer = document.getElementById(
      'currentTags',
    ) as HTMLDivElement;
    this.historySearch = document.getElementById(
      'historySearch',
    ) as HTMLInputElement;
    this.filterTagsContainer = document.getElementById(
      'filterTags',
    ) as HTMLDivElement;

    this.recordingInterface = document.querySelector(
      '.recording-interface',
    ) as HTMLDivElement;
    this.liveRecordingTitle = document.getElementById(
      'liveRecordingTitle',
    ) as HTMLDivElement;
    this.liveWaveformCanvas = document.getElementById(
      'liveWaveformCanvas',
    ) as HTMLCanvasElement;
    this.liveRecordingTimerDisplay = document.getElementById(
      'liveRecordingTimerDisplay',
    ) as HTMLDivElement;

    if (this.liveWaveformCanvas) {
      this.liveWaveformCtx = this.liveWaveformCanvas.getContext('2d');
    } else {
      console.warn(
        'Live waveform canvas element not found. Visualizer will not work.',
      );
    }

    if (this.recordingInterface) {
      this.statusIndicatorDiv = this.recordingInterface.querySelector(
        '.status-indicator',
      ) as HTMLDivElement;
    } else {
      console.warn('Recording interface element not found.');
      this.statusIndicatorDiv = null;
    }

    this.bindEventListeners();
    this.initTheme();
    
    this.initializeAppState();

    this.recordingStatus.textContent = 'Ready to record';
  }

  private async initializeAppState(): Promise<void> {
    const isShared = await this.checkSharedNote();
    if (isShared) return;
    
    const isRestored = this.restoreDraft();
    if (isRestored) return;
    
    this.createNewNote();
  }

  private bindEventListeners(): void {
    this.recordButton.addEventListener('click', () => this.toggleRecording());
    this.newButton.addEventListener('click', () => this.createNewNote());
    this.copyButton.addEventListener('click', () => this.copyNote());
    this.exportTxtButton.addEventListener('click', () => this.exportNote());
    this.exportPdfButton.addEventListener('click', () => this.exportPdf());
    this.uploadButton.addEventListener('click', () => this.audioUploadInput.click());
    this.audioUploadInput.addEventListener('change', (e) => this.handleFileUpload(e));
    this.shareButton.addEventListener('click', () => this.shareNote());
    this.undoButton.addEventListener('click', () => this.undo());
    this.redoButton.addEventListener('click', () => this.redo());
    this.installButton.addEventListener('click', () => this.handleInstallApp());

    window.addEventListener('beforeinstallprompt', (e) => {
      // Prevent the mini-infobar from appearing on mobile
      e.preventDefault();
      // Stash the event so it can be triggered later.
      this.deferredPrompt = e;
      // Update UI notify the user they can install the PWA
      this.installButton.classList.remove('hidden');
    });

    window.addEventListener('appinstalled', () => {
      // Clear the deferredPrompt so it can be garbage collected
      this.deferredPrompt = null;
      // Hide the install button
      this.installButton.classList.add('hidden');
      console.log('PWA was installed');
    });
    this.playPlaybackButton.addEventListener('click', () => this.togglePlayback());
    this.saveSharedToLocalButton.addEventListener('click', () => this.saveSharedToLocal());
    this.clearHistoryButton.addEventListener('click', () => this.clearAllHistory());
    document.getElementById('dismissDraft')?.addEventListener('click', () => {
        document.getElementById('draftToast')?.classList.remove('show');
    });
    this.historyToggleButton.addEventListener('click', () =>
      this.toggleHistory(true),
    );
    this.closeHistoryButton.addEventListener('click', () =>
      this.toggleHistory(false),
    );
    this.sidebarOverlay.addEventListener('click', () =>
      this.toggleHistory(false),
    );
    this.themeToggleButton.addEventListener('click', () => this.toggleTheme());
    window.addEventListener('resize', this.handleResize.bind(this));
    window.addEventListener('beforeunload', (e) => {
      if (this.hasUnsavedChanges) {
        e.preventDefault();
        e.returnValue = ''; // Standard way to show confirmation dialog
      }
    });

    this.editorTitle.addEventListener('input', () => {
      if (this.currentNote) {
        this.currentNote.title = this.editorTitle.textContent?.trim() || '';
        this.triggerAutoSave();
        this.debouncedHistoryPush();
      }
    });

    this.rawTranscription.addEventListener('input', () => {
      this.triggerAutoSave();
      this.debouncedHistoryPush();
    });
    this.polishedNote.addEventListener('input', () => {
      this.triggerAutoSave();
      this.debouncedHistoryPush();
    });

    // Keyboard shortcuts
    window.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
        e.preventDefault();
        this.undo();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'y') {
        e.preventDefault();
        this.redo();
      }
    });

    this.tagInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const tag = this.tagInput.value.trim();
        if (tag) {
          this.addTag(tag);
          this.tagInput.value = '';
        }
      }
    });

    this.historySearch.addEventListener('input', () => this.renderHistory());
  }

  private handleResize(): void {
    if (
      this.isRecording &&
      this.liveWaveformCanvas &&
      this.liveWaveformCanvas.style.display === 'block'
    ) {
      requestAnimationFrame(() => {
        this.setupCanvasDimensions();
      });
    }
  }

  private setupCanvasDimensions(): void {
    if (!this.liveWaveformCanvas || !this.liveWaveformCtx) return;

    const canvas = this.liveWaveformCanvas;
    const dpr = window.devicePixelRatio || 1;

    const rect = canvas.getBoundingClientRect();
    const cssWidth = rect.width;
    const cssHeight = rect.height;

    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);

    this.liveWaveformCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private initTheme(): void {
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme === 'light') {
      document.body.classList.add('light-mode');
      this.themeToggleIcon.classList.remove('fa-sun');
      this.themeToggleIcon.classList.add('fa-moon');
    } else {
      document.body.classList.remove('light-mode');
      this.themeToggleIcon.classList.remove('fa-moon');
      this.themeToggleIcon.classList.add('fa-sun');
    }
  }

  private toggleTheme(): void {
    document.body.classList.toggle('light-mode');
    if (document.body.classList.contains('light-mode')) {
      localStorage.setItem('theme', 'light');
      this.themeToggleIcon.classList.remove('fa-sun');
      this.themeToggleIcon.classList.add('fa-moon');
    } else {
      localStorage.setItem('theme', 'dark');
      this.themeToggleIcon.classList.remove('fa-moon');
      this.themeToggleIcon.classList.add('fa-sun');
    }
  }

  private async toggleRecording(): Promise<void> {
    if (!this.isRecording) {
      await this.startRecording();
    } else {
      await this.stopRecording();
    }
  }

  private setupAudioVisualizer(): void {
    if (!this.stream || this.audioContext) return;

    this.audioContext = new (window.AudioContext ||
      (window as any).webkitAudioContext)();
    const source = this.audioContext.createMediaStreamSource(this.stream);
    this.analyserNode = this.audioContext.createAnalyser();

    this.analyserNode.fftSize = 256;
    this.analyserNode.smoothingTimeConstant = 0.75;

    const bufferLength = this.analyserNode.frequencyBinCount;
    this.waveformDataArray = new Uint8Array(bufferLength);

    source.connect(this.analyserNode);
  }

  private drawLiveWaveform(): void {
    if (
      !this.analyserNode ||
      !this.waveformDataArray ||
      !this.liveWaveformCtx ||
      !this.liveWaveformCanvas ||
      !this.isRecording
    ) {
      if (this.waveformDrawingId) cancelAnimationFrame(this.waveformDrawingId);
      this.waveformDrawingId = null;
      return;
    }

    this.waveformDrawingId = requestAnimationFrame(() =>
      this.drawLiveWaveform(),
    );
    this.analyserNode.getByteFrequencyData(this.waveformDataArray);

    const ctx = this.liveWaveformCtx;
    const canvas = this.liveWaveformCanvas;

    const logicalWidth = canvas.clientWidth;
    const logicalHeight = canvas.clientHeight;

    ctx.clearRect(0, 0, logicalWidth, logicalHeight);

    const bufferLength = this.analyserNode.frequencyBinCount;
    const numBars = Math.floor(bufferLength * 0.5);

    if (numBars === 0) return;

    const totalBarPlusSpacingWidth = logicalWidth / numBars;
    const barWidth = Math.max(1, Math.floor(totalBarPlusSpacingWidth * 0.7));
    const barSpacing = Math.max(0, Math.floor(totalBarPlusSpacingWidth * 0.3));

    let x = 0;

    const recordingColor =
      getComputedStyle(document.documentElement)
        .getPropertyValue('--color-recording')
        .trim() || '#ff3b30';
    
    const accentColor = 
      getComputedStyle(document.documentElement)
        .getPropertyValue('--color-accent')
        .trim() || '#82aaff';

    for (let i = 0; i < numBars; i++) {
      if (x >= logicalWidth) break;

      const dataIndex = Math.floor(i * (bufferLength / numBars));
      const barHeightNormalized = this.waveformDataArray[dataIndex] / 255.0;
      let barHeight = barHeightNormalized * logicalHeight;

      if (barHeight < 1 && barHeight > 0) barHeight = 1;
      barHeight = Math.round(barHeight);

      const y = Math.round((logicalHeight - barHeight) / 2);

      // Enhanced styling: Color shift based on amplitude
      if (barHeightNormalized > 0.8) {
          ctx.fillStyle = '#ff3b30'; // Loud - Warning Red
      } else if (barHeightNormalized > 0.4) {
          ctx.fillStyle = accentColor; // Medium - Accent Blue
      } else {
          ctx.fillStyle = recordingColor; // Normal - Recording Red
      }

      // Add a subtle gradient effect per bar
      const gradient = ctx.createLinearGradient(0, y, 0, y + barHeight);
      const baseColor = ctx.fillStyle as string;
      gradient.addColorStop(0, baseColor);
      gradient.addColorStop(1, this.adjustColor(baseColor, -20));
      ctx.fillStyle = gradient;

      ctx.fillRect(Math.floor(x), y, barWidth, barHeight);
      x += barWidth + barSpacing;
    }
  }

  private adjustColor(color: string, amount: number): string {
    // If it's a hex color, shift it
    if (color.startsWith('#')) {
      const num = parseInt(color.slice(1), 16);
      let r = (num >> 16) + amount;
      let g = ((num >> 8) & 0x00FF) + amount;
      let b = (num & 0x0000FF) + amount;
      
      r = Math.max(0, Math.min(255, r));
      g = Math.max(0, Math.min(255, g));
      b = Math.max(0, Math.min(255, b));
      
      return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
    }
    return color;
  }

  private updateLiveTimer(): void {
    if (!this.isRecording || !this.liveRecordingTimerDisplay) return;
    const now = Date.now();
    const elapsedMs = now - this.recordingStartTime;

    const totalSeconds = Math.floor(elapsedMs / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    const hundredths = Math.floor((elapsedMs % 1000) / 10);

    this.liveRecordingTimerDisplay.textContent = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(hundredths).padStart(2, '0')}`;
  }

  private startLiveDisplay(): void {
    if (
      !this.recordingInterface ||
      !this.liveRecordingTitle ||
      !this.liveWaveformCanvas ||
      !this.liveRecordingTimerDisplay
    ) {
      console.warn(
        'One or more live display elements are missing. Cannot start live display.',
      );
      return;
    }

    this.recordingInterface.classList.add('is-live');
    this.liveRecordingTitle.style.display = 'block';
    this.liveWaveformCanvas.style.display = 'block';
    this.liveRecordingTimerDisplay.style.display = 'block';

    this.setupCanvasDimensions();

    if (this.statusIndicatorDiv) this.statusIndicatorDiv.style.display = 'none';

    const iconElement = this.recordButton.querySelector(
      '.record-button-inner i',
    ) as HTMLElement;
    if (iconElement) {
      iconElement.classList.remove('fa-microphone');
      iconElement.classList.add('fa-stop');
    }

    const currentTitle = this.editorTitle.textContent?.trim();
    const placeholder =
      this.editorTitle.getAttribute('placeholder') || 'Untitled Note';
    this.liveRecordingTitle.textContent =
      currentTitle && currentTitle !== placeholder
        ? currentTitle
        : 'New Recording';

    this.setupAudioVisualizer();
    this.drawLiveWaveform();

    this.recordingStartTime = Date.now();
    this.updateLiveTimer();
    if (this.timerIntervalId) clearInterval(this.timerIntervalId);
    this.timerIntervalId = window.setInterval(() => this.updateLiveTimer(), 50);
  }

  private stopLiveDisplay(): void {
    if (
      !this.recordingInterface ||
      !this.liveRecordingTitle ||
      !this.liveWaveformCanvas ||
      !this.liveRecordingTimerDisplay
    ) {
      if (this.recordingInterface)
        this.recordingInterface.classList.remove('is-live');
      return;
    }
    this.recordingInterface.classList.remove('is-live');
    this.liveRecordingTitle.style.display = 'none';
    this.liveWaveformCanvas.style.display = 'none';
    this.liveRecordingTimerDisplay.style.display = 'none';

    if (this.statusIndicatorDiv)
      this.statusIndicatorDiv.style.display = 'block';

    const iconElement = this.recordButton.querySelector(
      '.record-button-inner i',
    ) as HTMLElement;
    if (iconElement) {
      iconElement.classList.remove('fa-stop');
      iconElement.classList.add('fa-microphone');
    }

    if (this.waveformDrawingId) {
      cancelAnimationFrame(this.waveformDrawingId);
      this.waveformDrawingId = null;
    }
    if (this.timerIntervalId) {
      clearInterval(this.timerIntervalId);
      this.timerIntervalId = null;
    }
    if (this.liveWaveformCtx && this.liveWaveformCanvas) {
      this.liveWaveformCtx.clearRect(
        0,
        0,
        this.liveWaveformCanvas.width,
        this.liveWaveformCanvas.height,
      );
    }

    if (this.audioContext) {
      if (this.audioContext.state !== 'closed') {
        this.audioContext
          .close()
          .catch((e) => console.warn('Error closing audio context', e));
      }
      this.audioContext = null;
    }
    this.analyserNode = null;
    this.waveformDataArray = null;
  }

  private async startRecording(): Promise<void> {
    try {
      this.audioChunks = [];
      this.playPlaybackButton.classList.add('hidden');
      if (this.stream) {
        this.stream.getTracks().forEach((track) => track.stop());
        this.stream = null;
      }
      if (this.audioContext && this.audioContext.state !== 'closed') {
        await this.audioContext.close();
        this.audioContext = null;
      }

      this.recordingStatus.textContent = 'Requesting microphone access...';

      try {
        this.stream = await navigator.mediaDevices.getUserMedia({audio: true});
      } catch (err) {
        console.error('Failed with basic constraints:', err);
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          },
        });
      }

      try {
        this.mediaRecorder = new MediaRecorder(this.stream, {
          mimeType: 'audio/webm',
        });
      } catch (e) {
        console.error('audio/webm not supported, trying default:', e);
        this.mediaRecorder = new MediaRecorder(this.stream);
      }

      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0)
          this.audioChunks.push(event.data);
      };

      this.mediaRecorder.onstop = () => {
        this.stopLiveDisplay();

        if (this.audioChunks.length > 0) {
          const audioBlob = new Blob(this.audioChunks, {
            type: this.mediaRecorder?.mimeType || 'audio/webm',
          });
          this.processAudio(audioBlob).catch((err) => {
            console.error('Error processing audio:', err);
            this.recordingStatus.textContent = 'Error processing recording';
          });
        } else {
          this.recordingStatus.textContent =
            'No audio data captured. Please try again.';
        }

        if (this.stream) {
          this.stream.getTracks().forEach((track) => {
            track.stop();
          });
          this.stream = null;
        }
      };

      this.mediaRecorder.start();
      this.isRecording = true;

      this.recordButton.classList.add('recording');
      this.recordButton.setAttribute('title', 'Stop Recording');

      this.startLiveDisplay();
    } catch (error) {
      console.error('Error starting recording:', error);
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const errorName = error instanceof Error ? error.name : 'Unknown';

      if (
        errorName === 'NotAllowedError' ||
        errorName === 'PermissionDeniedError'
      ) {
        this.recordingStatus.textContent =
          'Microphone permission denied. Please check browser settings and reload page.';
      } else if (
        errorName === 'NotFoundError' ||
        (errorName === 'DOMException' &&
          errorMessage.includes('Requested device not found'))
      ) {
        this.recordingStatus.textContent =
          'No microphone found. Please connect a microphone.';
      } else if (
        errorName === 'NotReadableError' ||
        errorName === 'AbortError' ||
        (errorName === 'DOMException' &&
          errorMessage.includes('Failed to allocate audiosource'))
      ) {
        this.recordingStatus.textContent =
          'Cannot access microphone. It may be in use by another application.';
      } else {
        this.recordingStatus.textContent = `Error: ${errorMessage}`;
      }

      this.isRecording = false;
      if (this.stream) {
        this.stream.getTracks().forEach((track) => track.stop());
        this.stream = null;
      }
      this.recordButton.classList.remove('recording');
      this.recordButton.setAttribute('title', 'Start Recording');
      this.stopLiveDisplay();
    }
  }

  private async stopRecording(): Promise<void> {
    if (this.mediaRecorder && this.isRecording) {
      try {
        this.mediaRecorder.stop();
      } catch (e) {
        console.error('Error stopping MediaRecorder:', e);
        this.stopLiveDisplay();
      }

      this.isRecording = false;

      this.recordButton.classList.remove('recording');
      this.recordButton.setAttribute('title', 'Start Recording');
      this.recordingStatus.textContent = 'Processing audio...';
    } else {
      if (!this.isRecording) this.stopLiveDisplay();
    }
  }

  private async processAudio(audioBlob: Blob): Promise<void> {
    if (audioBlob.size === 0) {
      this.recordingStatus.textContent =
        'No audio data captured. Please try again.';
      return;
    }

    this.lastRecordedAudio = audioBlob;
    if (this.playPlaybackButton) {
      this.playPlaybackButton.classList.remove('hidden');
    }

    try {
      this.recordingStatus.textContent = 'Processing transcription...';
      
      const reader = new FileReader();
      reader.onloadend = async () => {
        const base64Audio = (reader.result as string).split(',')[1];
        const mimeType = audioBlob.type || 'audio/webm';
        await this.getTranscription(base64Audio, mimeType);
      };
      reader.readAsDataURL(audioBlob);

      if (this.currentNote) {
        this.saveCurrentNote(true);
      }
    } catch (error) {
      console.error('Error handling recorded audio:', error);
      this.recordingStatus.textContent = 'Error processing recording.';
    }
  }

  private handleFileUpload(e: Event): void {
    const input = e.target as HTMLInputElement;
    if (!input.files || input.files.length === 0) return;

    const file = input.files[0];
    this.recordingStatus.textContent = `Uploading ${file.name}...`;

    this.processAudio(file).then(() => {
      input.value = ''; // Reset input
    }).catch(err => {
      console.error('File upload error:', err);
      this.recordingStatus.textContent = 'Error processing uploaded file';
    });
  }

  private async getTranscription(
    base64Audio: string,
    mimeType: string,
  ): Promise<void> {
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: {
          parts: [
            {
              inlineData: {
                mimeType,
                data: base64Audio,
              },
            },
            {
              text: "Transcribe this audio exactly. Return only the transcription text.",
            },
          ],
        },
      });

      const transcription = response.text || '';
      
      this.rawTranscription.textContent = transcription;
      this.rawTranscription.classList.remove('placeholder-active');
      
      if (this.currentNote) {
        this.currentNote.rawTranscription = transcription;
        this.triggerAutoSave();
        this.debouncedHistoryPush();
      }

      await this.getPolishedNote();
    } catch (error) {
      console.error('Transcription error:', error);
      this.recordingStatus.textContent = 'Error during transcription.';
    }
  }

  private async getPolishedNote(): Promise<void> {
    const rawContent = this.rawTranscription.textContent?.trim();
    if (!rawContent || this.rawTranscription.classList.contains('placeholder-active')) {
      return;
    }

    this.recordingStatus.textContent = 'Polishing note...';
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: `Clean up this raw transcription for readability. Fix punctuation and obvious spelling/grammar errors. 
        DO NOT rewrite it, DO NOT add structure like bullet points or sections, and DO NOT change the tone. 
        Just a simple, clean version of exactly what was said. Return the cleaned text only.
        
        Raw Transcription:
        ${rawContent}`,
      });

      let polishedText = response.text || '';
      
      this.polishedNote.textContent = polishedText;
      this.polishedNote.classList.remove('placeholder-active');

      if (this.currentNote) {
        this.currentNote.polishedNote = polishedText;
        this.triggerAutoSave();
        this.debouncedHistoryPush();
      }
      
      this.recordingStatus.textContent = 'Transcription complete and polished!';
    } catch (error) {
      console.error('Polishing error:', error);
      this.recordingStatus.textContent = 'Error polishing note.';
    }
  }

  private pushToUndoStack(): void {
    if (this.isPushingToStack) return;

    const currentState: AppState = {
      title: this.editorTitle.textContent?.trim() || '',
      raw: this.rawTranscription.textContent || '',
      polished: this.polishedNote.innerHTML || '',
      tags: this.currentNote ? [...this.currentNote.tags] : []
    };

    // Only push if different from last state
    if (this.undoStack.length > 0) {
      const lastState = this.undoStack[this.undoStack.length - 1];
      if (lastState.title === currentState.title && 
          lastState.raw === currentState.raw && 
          lastState.polished === currentState.polished &&
          JSON.stringify(lastState.tags) === JSON.stringify(currentState.tags)) {
        return;
      }
    }

    this.undoStack.push(currentState);
    if (this.undoStack.length > 50) this.undoStack.shift();
    this.redoStack = []; // Clear redo stack on new action
    this.updateUndoRedoButtons();
  }

  private async handleInstallApp(): Promise<void> {
    if (!this.deferredPrompt) return;
    
    // Show the install prompt
    this.deferredPrompt.prompt();
    
    // Wait for the user to respond to the prompt
    const { outcome } = await this.deferredPrompt.userChoice;
    
    if (outcome === 'accepted') {
      console.log('User accepted the install prompt');
    } else {
      console.log('User dismissed the install prompt');
    }
    
    // We've used the prompt, and can't use it again, throw it away
    this.deferredPrompt = null;
    
    // Hide the install button
    this.installButton.classList.add('hidden');
  }

  private undo(): void {
    if (this.undoStack.length <= 1) return;

    this.isPushingToStack = true;
    const currentState = this.undoStack.pop()!;
    this.redoStack.push(currentState);

    const previousState = this.undoStack[this.undoStack.length - 1];
    this.applyState(previousState);
    
    this.isPushingToStack = false;
    this.updateUndoRedoButtons();
  }

  private redo(): void {
    if (this.redoStack.length === 0) return;

    this.isPushingToStack = true;
    const state = this.redoStack.pop()!;
    this.undoStack.push(state);

    this.applyState(state);

    this.isPushingToStack = false;
    this.updateUndoRedoButtons();
  }

  private applyState(state: AppState): void {
    if (this.editorTitle) {
      this.editorTitle.textContent = state.title || 'Untitled Note';
      this.editorTitle.classList.toggle('placeholder-active', !state.title);
    }
    this.rawTranscription.textContent = state.raw;
    this.rawTranscription.classList.toggle('placeholder-active', !state.raw);
    this.polishedNote.innerHTML = state.polished;
    this.polishedNote.classList.toggle('placeholder-active', !state.polished);
    
    if (this.currentNote) {
      this.currentNote.title = state.title;
      this.currentNote.rawTranscription = state.raw;
      this.currentNote.polishedNote = state.polished;
      this.currentNote.tags = [...state.tags];
      this.renderCurrentTags();
      this.saveCurrentNote(true);
    }
  }

  private updateUndoRedoButtons(): void {
    if (this.undoButton) this.undoButton.disabled = this.undoStack.length <= 1;
    if (this.redoButton) this.redoButton.disabled = this.redoStack.length === 0;
  }

  private historyPushTimeout: number | null = null;
  private debouncedHistoryPush(): void {
    if (this.historyPushTimeout) clearTimeout(this.historyPushTimeout);
    this.historyPushTimeout = window.setTimeout(() => this.pushToUndoStack(), 1000);
  }

  private createNewNote(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.updateUndoRedoButtons();

    this.currentNote = {
      id: `note_${Date.now()}`,
      title: 'Untitled Note',
      rawTranscription: '',
      polishedNote: '',
      timestamp: Date.now(),
      tags: [],
    };

    const rawPlaceholder =
      this.rawTranscription.getAttribute('placeholder') || '';
    this.rawTranscription.textContent = rawPlaceholder;
    this.rawTranscription.classList.add('placeholder-active');

    const polishedPlaceholder =
      this.polishedNote.getAttribute('placeholder') || '';
    this.polishedNote.innerHTML = polishedPlaceholder;
    this.polishedNote.classList.add('placeholder-active');

    if (this.editorTitle) {
      const placeholder =
        this.editorTitle.getAttribute('placeholder') || 'Untitled Note';
      this.editorTitle.textContent = placeholder;
      this.editorTitle.classList.add('placeholder-active');
    }

    this.renderCurrentTags();
    this.recordingStatus.textContent = 'Ready to record';

    if (this.isRecording) {
      this.mediaRecorder?.stop();
      this.isRecording = false;
      this.recordButton.classList.remove('recording');
    } else {
      this.stopLiveDisplay();
    }

    this.pushToUndoStack();
  }

  private copyNote(): void {
    if (!this.currentNote) return;

    // Ensure current content is saved to state
    const title = this.editorTitle.textContent?.trim() || 'Untitled Note';
    const rawContent =
      this.rawTranscription.classList.contains('placeholder-active')
        ? ''
        : this.rawTranscription.textContent || '';
    const polishedContent =
      this.polishedNote.classList.contains('placeholder-active')
        ? ''
        : this.polishedNote.innerHTML || '';

    const newNote: Note = {
      id: `note_${Date.now()}`,
      title: `${title} (Copy)`,
      rawTranscription: rawContent,
      polishedNote: polishedContent,
      timestamp: Date.now(),
      tags: [...this.currentNote.tags],
    };

    const history = this.getHistory();
    history.unshift(newNote);
    localStorage.setItem('notes_history', JSON.stringify(history));

    this.loadNote(newNote);
    this.recordingStatus.textContent = 'Note duplicated!';
    this.renderHistory();
    
    // Add visual feedback
    this.copyButton.classList.add('success-flash');
    setTimeout(() => this.copyButton.classList.remove('success-flash'), 1000);
  }

  private saveCurrentNote(isAutoSave = false): void {
    if (!this.currentNote) return;

    const title = this.editorTitle.textContent?.trim() || 'Untitled Note';
    const rawContent =
      this.rawTranscription.classList.contains('placeholder-active')
        ? ''
        : this.rawTranscription.textContent || '';
    const polishedContent =
      this.polishedNote.classList.contains('placeholder-active')
        ? ''
        : this.polishedNote.innerHTML || '';

    if (!isAutoSave && !rawContent && !polishedContent && title === 'Untitled Note') {
      this.recordingStatus.textContent = 'Nothing to save';
      return;
    }

    this.currentNote.title = title;
    this.currentNote.rawTranscription = rawContent;
    this.currentNote.polishedNote = polishedContent;
    this.currentNote.timestamp = Date.now();

    const history = this.getHistory();
    const existingIndex = history.findIndex(
      (n) => n.id === this.currentNote?.id,
    );

    if (existingIndex > -1) {
      history[existingIndex] = this.currentNote;
    } else {
      history.unshift(this.currentNote);
    }

    localStorage.setItem('notes_history', JSON.stringify(history));
    
    if (isAutoSave) {
      console.log('Auto-saved note');
      this.hasUnsavedChanges = false;
      this.saveDraft();
      // Briefly show auto-save status if needed, but not too distracting
    } else {
      this.hasUnsavedChanges = false;
      this.clearDraft();
      this.recordingStatus.textContent = 'Note saved to history';
      this.renderHistory();
    }
  }

  private triggerAutoSave(): void {
    this.hasUnsavedChanges = true;
    if (this.autoSaveTimeout) {
      clearTimeout(this.autoSaveTimeout);
    }
    this.autoSaveTimeout = window.setTimeout(() => {
      this.saveCurrentNote(true);
    }, 3000); // 3 seconds of inactivity
  }

  private addTag(tag: string): void {
    if (!this.currentNote) return;
    tag = tag.trim().toLowerCase();
    if (tag && !this.currentNote.tags.includes(tag)) {
      this.currentNote.tags.push(tag);
      this.renderCurrentTags();
      this.triggerAutoSave();
    }
  }

  private removeTag(tag: string): void {
    if (!this.currentNote) return;
    this.currentNote.tags = this.currentNote.tags.filter((t) => t !== tag);
    this.renderCurrentTags();
    this.triggerAutoSave();
  }

  private renderCurrentTags(): void {
    if (!this.currentTagsContainer || !this.currentNote) return;
    this.currentTagsContainer.innerHTML = '';
    this.currentNote.tags.forEach((tag) => {
      const chip = document.createElement('div');
      chip.className = 'tag-chip';
      chip.innerHTML = `
        <span>${tag}</span>
        <i class="fas fa-times remove-tag" data-tag="${tag}"></i>
      `;
      chip.querySelector('.remove-tag')?.addEventListener('click', () => this.removeTag(tag));
      this.currentTagsContainer.appendChild(chip);
    });
  }

  private exportNote(): void {
    if (!this.currentNote) return;
    
    const title = this.editorTitle.textContent?.trim() || 'Untitled Note';
    const rawContent = this.rawTranscription.textContent || '';
    const polishedContent = this.stripHtml(this.polishedNote.innerHTML || '');
    
    const content = `TITLE: ${title}\nDATE: ${new Date(this.currentNote.timestamp).toLocaleString()}\nTAGS: ${this.currentNote.tags.join(', ')}\n\n--- POLISHED NOTE ---\n${polishedContent}\n\n--- RAW TRANSCRIPTION ---\n${rawContent}`;
    
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${title.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    this.recordingStatus.textContent = 'Note exported as .txt';
  }

  private exportPdf(): void {
    if (!this.currentNote) return;

    const title = this.editorTitle.textContent?.trim() || 'Untitled Note';
    const rawContent = this.rawTranscription.textContent || '';
    const polishedContent = this.stripHtml(this.polishedNote.innerHTML || '');

    const doc = new jsPDF();
    const margin = 10;
    const pageWidth = doc.internal.pageSize.width;
    const contentWidth = pageWidth - 2 * margin;

    doc.setFontSize(18);
    doc.text(title, margin, 20);

    doc.setFontSize(10);
    doc.setTextColor(100);
    doc.text(`Date: ${new Date(this.currentNote.timestamp).toLocaleString()}`, margin, 30);
    doc.text(`Tags: ${this.currentNote.tags.join(', ')}`, margin, 35);

    let currentY = 45;

    doc.setFontSize(14);
    doc.setTextColor(0);
    doc.text('Polished Note', margin, currentY);
    currentY += 10;

    doc.setFontSize(11);
    const polishedLines = doc.splitTextToSize(polishedContent, contentWidth);
    doc.text(polishedLines, margin, currentY);
    currentY += (polishedLines.length * 7) + 10;

    if (currentY > 250) {
      doc.addPage();
      currentY = 20;
    }

    doc.setFontSize(14);
    doc.text('Raw Transcription', margin, currentY);
    currentY += 10;

    doc.setFontSize(10);
    doc.setTextColor(100);
    const rawLines = doc.splitTextToSize(rawContent, contentWidth);
    doc.text(rawLines, margin, currentY);

    doc.save(`${title.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.pdf`);
    this.recordingStatus.textContent = 'Note exported as .pdf';
  }

  private getHistory(): any[] {
    const historyJson = localStorage.getItem('notes_history');
    return historyJson ? JSON.parse(historyJson) : [];
  }

  private toggleHistory(show: boolean): void {
    if (show) {
      this.activeFilterTags.clear();
      this.renderFilterTags();
      this.renderHistory();
      this.historySidebar.classList.add('open');
      this.sidebarOverlay.classList.add('active');
    } else {
      this.historySidebar.classList.remove('open');
      this.sidebarOverlay.classList.remove('active');
    }
  }

  private renderFilterTags(): void {
    const history = this.getHistory();
    const tags = new Set<string>();
    history.forEach(note => note.tags?.forEach((t: string) => tags.add(t)));
    
    this.filterTagsContainer.innerHTML = '';
    tags.forEach(tag => {
      const el = document.createElement('div');
      el.className = `filter-tag ${this.activeFilterTags.has(tag) ? 'active' : ''}`;
      el.textContent = tag;
      el.addEventListener('click', () => {
        if (this.activeFilterTags.has(tag)) {
          this.activeFilterTags.delete(tag);
        } else {
          this.activeFilterTags.clear(); // Exclusive filter for now, or multi? Let's do multi-toggle
          this.activeFilterTags.add(tag);
        }
        this.renderFilterTags();
        this.renderHistory();
      });
      this.filterTagsContainer.appendChild(el);
    });
  }

  private renderHistory(): void {
    const history = this.getHistory();
    const searchQuery = this.historySearch.value.toLowerCase();
    
    let filtered = history.filter(note => {
      const matchesSearch = note.title.toLowerCase().includes(searchQuery) || 
                           note.rawTranscription.toLowerCase().includes(searchQuery) ||
                           note.polishedNote.toLowerCase().includes(searchQuery);
      
      const matchesTags = this.activeFilterTags.size === 0 || 
                         (note.tags && Array.from(this.activeFilterTags).every(t => note.tags.includes(t)));
      
      return matchesSearch && matchesTags;
    });

    this.historyList.innerHTML = '';

    if (filtered.length === 0) {
      this.historyList.innerHTML =
        '<div class="history-empty-message">No matching notes found</div>';
      return;
    }

    filtered.forEach((note) => {
      const date = new Date(note.timestamp).toLocaleString();
      const div = document.createElement('div');
      div.className = 'history-item';
      div.innerHTML = `
        <div class="history-item-title">${note.title || 'Untitled Note'}</div>
        <div class="history-item-date">${date}</div>
        <div class="history-item-preview">${this.stripHtml(note.polishedNote || note.rawTranscription).substring(0, 100)}...</div>
        <div class="history-item-tags">
          ${note.tags ? note.tags.map((t: string) => `<span class="history-tag-chip">${t}</span>`).join('') : ''}
        </div>
        <div class="history-item-actions">
          <button class="delete-history-btn" data-id="${note.id}">
            <i class="fas fa-trash"></i>
          </button>
        </div>
      `;

      div.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('.delete-history-btn')) return;
        this.loadNote(note);
        this.toggleHistory(false);
      });

      const deleteBtn = div.querySelector('.delete-history-btn');
      deleteBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        this.deleteNote(note.id);
      });

      this.historyList.appendChild(div);
    });
  }

  private loadNote(note: any): void {
    this.undoStack = [];
    this.redoStack = [];
    this.updateUndoRedoButtons();

    this.currentNote = {...note, tags: note.tags || []};

    if (this.editorTitle) {
      this.editorTitle.textContent = note.title || 'Untitled Note';
      this.editorTitle.classList.remove('placeholder-active');
    }

    this.renderCurrentTags();

    if (note.rawTranscription) {
      this.rawTranscription.textContent = note.rawTranscription;
      this.rawTranscription.classList.remove('placeholder-active');
    } else {
      const placeholder =
        this.rawTranscription.getAttribute('placeholder') || '';
      this.rawTranscription.textContent = placeholder;
      this.rawTranscription.classList.add('placeholder-active');
    }

    if (note.polishedNote) {
      this.polishedNote.innerHTML = note.polishedNote;
      this.polishedNote.classList.remove('placeholder-active');
    } else {
      const placeholder =
        this.polishedNote.getAttribute('placeholder') || '';
      this.polishedNote.innerHTML = placeholder;
      this.polishedNote.classList.add('placeholder-active');
    }

    this.recordingStatus.textContent = 'Note loaded from history';
    this.pushToUndoStack();
  }

  private deleteNote(id: string): void {
    let history = this.getHistory();
    history = history.filter((n) => n.id !== id);
    localStorage.setItem('notes_history', JSON.stringify(history));
    this.renderHistory();

    if (this.currentNote?.id === id) {
      this.createNewNote();
    }
  }

  private clearAllHistory(): void {
    const history = this.getHistory();
    if (history.length === 0) return;

    if (window.confirm('Are you sure you want to clear your entire note history? This action cannot be undone.')) {
      localStorage.removeItem('notes_history');
      this.renderHistory();
      this.createNewNote();
      this.recordingStatus.textContent = 'Note history cleared';
    }
  }

  private async shareNote(): Promise<void> {
    if (!this.currentNote) return;

    this.saveDraft(); // Save state before sharing

    const title = this.editorTitle.textContent?.trim() || 'Untitled Note';
    const polishedContent = this.polishedNote.classList.contains('placeholder-active')
      ? ''
      : this.polishedNote.innerHTML || '';

    if (!polishedContent) {
      this.recordingStatus.textContent = 'Nothing to share - please transcribe first';
      return;
    }

    this.shareButton.disabled = true;
    this.recordingStatus.textContent = 'Generating share link...';

    try {
      const noteId = `share_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
      const sharedNoteRef = doc(db, 'sharedNotes', noteId);

      const sharedData = {
        title: title,
        polishedNote: polishedContent,
        tags: this.currentNote.tags,
        timestamp: Date.now(),
        createdAt: serverTimestamp()
      };

      await setDoc(sharedNoteRef, sharedData);

      const shareUrl = `${window.location.origin}${window.location.pathname}?share=${noteId}`;
      
      // Copy to clipboard
      await navigator.clipboard.writeText(shareUrl);

      // Show toast
      const toast = document.getElementById('shareToast');
      if (toast) {
        toast.classList.add('show');
        setTimeout(() => toast.classList.remove('show'), 3000);
      }

      this.recordingStatus.textContent = 'Share link copied to clipboard!';
    } catch (err) {
      console.error('Error sharing note:', err);
      this.recordingStatus.textContent = 'Error generating share link';
    } finally {
      this.shareButton.disabled = false;
    }
  }

  private async checkSharedNote(): Promise<boolean> {
    const params = new URLSearchParams(window.location.search);
    const shareId = params.get('share');

    if (shareId) {
      document.body.classList.add('shared-view');
      this.recordingStatus.textContent = 'Loading shared note...';

      try {
        const noteRef = doc(db, 'sharedNotes', shareId);
        const noteSnap = await getDoc(noteRef);

        if (noteSnap.exists()) {
          const data = noteSnap.data();
          
          if (this.editorTitle) {
            this.editorTitle.textContent = data.title || 'Shared Note';
            this.editorTitle.classList.remove('placeholder-active');
            this.editorTitle.setAttribute('contenteditable', 'true');
          }

          this.polishedNote.innerHTML = data.polishedNote || '';
          this.polishedNote.classList.remove('placeholder-active');
          this.polishedNote.setAttribute('contenteditable', 'true');

          const icon = this.newButton.querySelector('i');
          if (icon) {
            icon.classList.remove('fa-plus');
            icon.classList.add('fa-home');
          }
          this.newButton.title = 'Go to my notes';
          this.newButton.onclick = (e) => {
              e.preventDefault();
              window.location.href = window.location.origin + window.location.pathname;
          };

          this.saveSharedToLocalButton.classList.remove('hidden');

          // Format tags if any
          if (data.tags && Array.isArray(data.tags)) {
            this.currentNote = {
              id: 'shared',
              title: data.title,
              rawTranscription: '',
              polishedNote: data.polishedNote,
              timestamp: data.timestamp,
              tags: data.tags
            };
            this.renderCurrentTags();
          }
          this.recordingStatus.textContent = 'Viewing shared note (Editable)';
          return true;
        } else {
          this.recordingStatus.textContent = 'Shared note not found';
          this.polishedNote.innerHTML = '<h1>Note Not Found</h1><p>The shared note you are looking for does not exist or has been removed.</p>';
          return false;
        }
      } catch (err) {
        console.error('Error loading shared note:', err);
        this.recordingStatus.textContent = 'Error loading shared note';
        return false;
      }
    }
    return false;
  }

  private stripHtml(html: string): string {
    const tmp = document.createElement('DIV');
    tmp.innerHTML = html;
    return tmp.textContent || tmp.innerText || '';
  }

  private togglePlayback(): void {
    if (!this.lastRecordedAudio) return;

    if (this.playbackAudio && !this.playbackAudio.paused) {
      this.playbackAudio.pause();
      this.playPlaybackButton.innerHTML = '<i class="fas fa-play"></i>';
      return;
    }

    if (!this.playbackAudio) {
      const audioUrl = URL.createObjectURL(this.lastRecordedAudio);
      this.playbackAudio = new Audio(audioUrl);
      this.playbackAudio.onended = () => {
        this.playPlaybackButton.innerHTML = '<i class="fas fa-play"></i>';
      };
    }

    this.playbackAudio.play();
    this.playPlaybackButton.innerHTML = '<i class="fas fa-pause"></i>';
  }

  private saveSharedToLocal(): void {
    if (!this.currentNote) return;
    
    const notesHistory = this.getHistory();
    const newNote = { ...this.currentNote, id: `note_${Date.now()}` };
    notesHistory.unshift(newNote);
    localStorage.setItem('notes_history', JSON.stringify(notesHistory));
    
    this.recordingStatus.textContent = 'Note saved to your history!';
    this.saveSharedToLocalButton.classList.add('hidden');
    
    // Redirect to home view showing the new note in history
    setTimeout(() => {
        window.location.href = window.location.origin + window.location.pathname;
    }, 1500);
  }

  private saveDraft(): void {
    if (!this.currentNote) return;
    
    const draft = {
      title: this.editorTitle.textContent?.trim() || '',
      rawTranscription: this.rawTranscription.classList.contains('placeholder-active') ? '' : this.rawTranscription.textContent,
      polishedNote: this.polishedNote.classList.contains('placeholder-active') ? '' : this.polishedNote.innerHTML,
      tags: Array.from(this.currentNote.tags)
    };
    
    localStorage.setItem('notes_draft', JSON.stringify(draft));
  }

  private restoreDraft(): boolean {
    const draftStr = localStorage.getItem('notes_draft');
    if (!draftStr) return false;

    try {
      const draft = JSON.parse(draftStr);
      if (!draft.rawTranscription && !draft.polishedNote && !draft.title) return false;

      if (this.editorTitle) {
        this.editorTitle.textContent = draft.title || 'Untitled Note';
        if (draft.title) this.editorTitle.classList.remove('placeholder-active');
      }

      if (draft.rawTranscription) {
        this.rawTranscription.textContent = draft.rawTranscription;
        this.rawTranscription.classList.remove('placeholder-active');
      }

      if (draft.polishedNote) {
        this.polishedNote.innerHTML = draft.polishedNote;
        this.polishedNote.classList.remove('placeholder-active');
      }

      this.undoStack = [];
      this.redoStack = [];

      this.currentNote = {
        id: 'draft_' + Date.now(),
        title: draft.title || 'Untitled Draft',
        rawTranscription: draft.rawTranscription || '',
        polishedNote: draft.polishedNote || '',
        timestamp: Date.now(),
        tags: draft.tags || []
      };
      
      this.renderCurrentTags();
      this.pushToUndoStack();

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
  }

  private clearDraft(): void {
    localStorage.removeItem('notes_draft');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  new VoiceNotesApp();

  // Register Service Worker for PWA
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js')
        .then(reg => {
          console.log('SW registered:', reg);
          reg.addEventListener('updatefound', () => {
            const newWorker = reg.installing;
            if (newWorker) {
              newWorker.addEventListener('statechange', () => {
                if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                  window.location.reload();
                }
              });
            }
          });
        })
        .catch(err => console.log('SW registration failed:', err));
    });

    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!refreshing) {
        refreshing = true;
        window.location.reload();
      }
    });
  }

  document
    .querySelectorAll<HTMLElement>('[contenteditable][placeholder]')
    .forEach((el) => {
      const placeholder = el.getAttribute('placeholder')!;

      function updatePlaceholderState() {
        const currentText = (
          el.id === 'polishedNote' ? el.innerText : el.textContent
        )?.trim();

        if (currentText === '' || currentText === placeholder) {
          if (el.id === 'polishedNote' && currentText === '') {
            el.innerHTML = placeholder;
          } else if (currentText === '') {
            el.textContent = placeholder;
          }
          el.classList.add('placeholder-active');
        } else {
          el.classList.remove('placeholder-active');
        }
      }

      updatePlaceholderState();

      el.addEventListener('focus', function () {
        const currentText = (
          this.id === 'polishedNote' ? this.innerText : this.textContent
        )?.trim();
        if (currentText === placeholder) {
          if (this.id === 'polishedNote') this.innerHTML = '';
          else this.textContent = '';
          this.classList.remove('placeholder-active');
        }
      });

      el.addEventListener('blur', function () {
        updatePlaceholderState();
      });
    });
});

export {};
