import express from 'express';
import type { Request, Response } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { OpenAI } from 'openai';
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
logDebug(`Server starting. NODE_ENV: ${process.env.NODE_ENV}. OPENAI_API_KEY length: ${process.env.OPENAI_API_KEY ? process.env.OPENAI_API_KEY.length : 'undefined'}`);

// Set body limit high enough for base64 encoded audio
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));

// Lazy initializer for OpenAI client
let openaiClient: OpenAI | null = null;

function getOpenAIClient(): OpenAI {
  if (openaiClient) return openaiClient;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    logDebug('OPENAI_API_KEY is missing in getOpenAIClient');
    throw new Error('OPENAI_API_KEY environment variable is required but missing on the server.');
  }

  logDebug(`OPENAI_API_KEY is present (length: ${apiKey.length})`);
  openaiClient = new OpenAI({ apiKey });

  return openaiClient;
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

    // Map mimeType to a standard extension for Whisper compatibility
    let extension = 'webm';
    if (mimeType.includes('audio/mp4') || mimeType.includes('audio/m4a') || mimeType.includes('audio/x-m4a')) {
      extension = 'm4a';
    } else if (mimeType.includes('audio/mpeg') || mimeType.includes('audio/mp3')) {
      extension = 'mp3';
    } else if (mimeType.includes('audio/wav') || mimeType.includes('audio/x-wav')) {
      extension = 'wav';
    } else if (mimeType.includes('audio/ogg')) {
      extension = 'ogg';
    }

    const tempFileName = `temp_${Date.now()}.${extension}`;
    const tempFilePath = path.join(__dirname, tempFileName);
    const audioBuffer = Buffer.from(base64Audio, 'base64');
    
    fs.writeFileSync(tempFilePath, audioBuffer);
    logDebug(`Saved temp audio file to ${tempFilePath} (${audioBuffer.length} bytes)`);

    const openai = getOpenAIClient();
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tempFilePath),
      model: 'whisper-1',
    });

    // Clean up temporary file
    try {
      fs.unlinkSync(tempFilePath);
      logDebug(`Deleted temp file ${tempFilePath}`);
    } catch (cleanupErr) {
      logDebug('Error deleting temp audio file', cleanupErr);
    }

    logDebug(`Transcription response received: ${transcription.text ? transcription.text.substring(0, 100) : 'empty'}`);
    res.json({ transcription: transcription.text || '' });
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

    const openai = getOpenAIClient();
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'Clean up this raw transcription for readability. Fix punctuation and obvious spelling/grammar errors. DO NOT rewrite it, DO NOT add structure like bullet points or sections, and DO NOT change the tone. Just a simple, clean version of exactly what was said. Return the cleaned text only.'
        },
        {
          role: 'user',
          content: rawContent
        }
      ]
    });

    const polishedText = completion.choices[0]?.message?.content || '';
    res.json({ polishedText });
  } catch (error: any) {
    console.error('Server polishing error:', error);
    res.status(500).json({ 
      error: error.message || 'An error occurred during polishing on the server.' 
    });
  }
});

// Text-to-Speech route
app.post('/api/tts', async (req: Request, res: Response): Promise<void> => {
  try {
    const { text } = req.body;
    
    if (!text) {
      res.status(400).json({ error: 'Missing text content' });
      return;
    }

    logDebug(`TTS requested for text length: ${text.length}`);

    const openai = getOpenAIClient();
    const mp3 = await openai.audio.speech.create({
      model: 'tts-1',
      voice: 'alloy',
      input: text,
    });

    const buffer = Buffer.from(await mp3.arrayBuffer());
    
    res.set('Content-Type', 'audio/mpeg');
    res.send(buffer);
  } catch (error: any) {
    console.error('Server TTS error:', error);
    res.status(500).json({ 
      error: error.message || 'An error occurred during TTS on the server.' 
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
