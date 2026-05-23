import express from 'express';
import type { Request, Response } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

const LOG_FILE = path.join(__dirname, 'server-debug.log');

function logDebug(message: string, error?: any) {
  const timestamp = new Date().toISOString();
  const logMsg = `[${timestamp}] ${message}` + (error ? `\nError: ${error.stack || error.message || error}\n` : '\n');
  console.log(logMsg);
  try {
    fs.appendFileSync(LOG_FILE, logMsg);
  } catch (e) {
    // Ignore logging errors
  }
}

// Log startup information
logDebug(`Server starting. NODE_ENV: ${process.env.NODE_ENV}. GEMINI_API_KEY length: ${process.env.GEMINI_API_KEY ? process.env.GEMINI_API_KEY.length : 'undefined'}`);

// Set body limit high enough for base64 encoded audio
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));

// Lazy initializer for Gemini client
let geminiClient: GoogleGenAI | null = null;

function getGeminiClient(): GoogleGenAI {
  if (geminiClient) return geminiClient;

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    logDebug('GEMINI_API_KEY is missing in getGeminiClient');
    throw new Error('GEMINI_API_KEY environment variable is required but missing on the server.');
  }

  logDebug(`GEMINI_API_KEY is present (length: ${apiKey.length})`);
  geminiClient = new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      }
    }
  });

  return geminiClient;
}

// Transcription route
app.post('/api/transcribe', async (req: Request, res: Response): Promise<void> => {
  logDebug('Received transcription request');
  try {
    const { base64Audio, mimeType } = req.body;
    
    if (!base64Audio) {
      logDebug('Error: Missing base64Audio content');
      res.status(400).json({ error: 'Missing base64Audio content' });
      return;
    }
    if (!mimeType) {
      logDebug('Error: Missing mimeType');
      res.status(400).json({ error: 'Missing mimeType' });
      return;
    }

    logDebug(`Audio MIME type: ${mimeType}, Base64 length: ${base64Audio.length}`);

    const ai = getGeminiClient();
    const response = await ai.models.generateContent({
      model: 'gemini-3.5-flash',
      contents: {
        parts: [
          {
            inlineData: {
              mimeType,
              data: base64Audio,
            }
          },
          {
            text: 'Transcribe this audio exactly. Return only the transcription text.'
          }
        ]
      }
    });

    logDebug(`Transcription response received: ${response.text ? response.text.substring(0, 100) : 'empty'}`);
    res.json({ transcription: response.text || '' });
  } catch (error: any) {
    logDebug('Server transcription error', error);
    res.status(500).json({ 
      error: error.message || 'An error occurred during voice transcription on the server.' 
    });
  }
});

// Polish note route
app.post('/api/polish', async (req: Request, res: Response): Promise<void> => {
  try {
    const { rawContent } = req.body;
    
    if (!rawContent) {
      res.status(400).json({ error: 'Missing rawContent' });
      return;
    }

    const ai = getGeminiClient();
    const response = await ai.models.generateContent({
      model: 'gemini-3.5-flash',
      contents: `Clean up this raw transcription for readability. Fix punctuation and obvious spelling/grammar errors. 
      DO NOT rewrite it, DO NOT add structure like bullet points or sections, and DO NOT change the tone. 
      Just a simple, clean version of exactly what was said. Return the cleaned text only.
      
      Raw Transcription:
      ${rawContent}`
    });

    res.json({ polishedText: response.text || '' });
  } catch (error: any) {
    console.error('Server polishing error:', error);
    res.status(500).json({ 
      error: error.message || 'An error occurred during polishing on the server.' 
    });
  }
});

// Serve frontend build output statically in production
const distPath = path.resolve(__dirname, 'dist');
app.use(express.static(distPath));

// Fallback all frontend routes to index.html
app.get('/{*splat}', (req: Request, res: Response) => {
  res.sendFile(path.join(distPath, 'index.html'));
});

// Determine Port: 3000 in production Cloud Run, 3001 in development (proxied by Vite)
const isProd = process.env.NODE_ENV === 'production';
const PORT = isProd ? (process.env.PORT || 3000) : 3001;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Server] VoiceNotesApp backend running on http://0.0.0.0:${PORT} (${isProd ? 'Production' : 'Development'})`);
});
