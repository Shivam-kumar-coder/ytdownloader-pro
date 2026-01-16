import express from 'express';
import cors from 'cors';
import axios from 'axios';
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const execAsync = promisify(exec);

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({
  origin: ['https://ytdownloader-pro.vercel.app', 'http://localhost:3000'],
  credentials: true
}));
app.use(express.json());
app.use(express.static('public'));

// Check if yt-dlp is installed
async function checkYtDlp() {
  try {
    await execAsync('yt-dlp --version');
    console.log('✓ yt-dlp is installed');
    return true;
  } catch {
    console.log('✗ yt-dlp not found, installing...');
    try {
      await execAsync('pip3 install yt-dlp');
      console.log('✓ yt-dlp installed successfully');
      return true;
    } catch (error) {
      console.error('Failed to install yt-dlp:', error);
      return false;
    }
  }
}

// Health Check
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    service: 'YTDownloader API',
    ytDlp: 'Checking...'
  });
});

// Get Video Info
app.get('/api/info', async (req, res) => {
  try {
    const { url } = req.query;
    
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    // Extract video ID
    const videoId = extractVideoId(url);
    if (!videoId) {
      return res.status(400).json({ error: 'Invalid YouTube URL' });
    }

    // Get info using yt-dlp
    const command = `yt-dlp --dump-json --no-warnings "https://www.youtube.com/watch?v=${videoId}"`;
    
    try {
      const { stdout } = await execAsync(command, { timeout: 30000 });
      const info = JSON.parse(stdout);
      
      res.json({
        success: true,
        data: {
          id: videoId,
          title: info.title,
          thumbnail: info.thumbnail,
          duration: formatDuration(info.duration),
          channel: info.uploader,
          view_count: info.view_count,
          formats: info.formats ? info.formats.slice(0, 5).map(f => ({
            quality: f.format_note || f.resolution,
            ext: f.ext,
            filesize: f.filesize ? formatFileSize(f.filesize) : 'Unknown'
          })) : []
        }
      });
    } catch (execError) {
      // Fallback to API method
      const fallbackInfo = await getInfoFromAPI(videoId);
      res.json({
        success: true,
        data: fallbackInfo
      });
    }
  } catch (error) {
    console.error('Info error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to get video info',
      message: error.message 
    });
  }
});

// Download Endpoint
app.get('/api/download', async (req, res) => {
  try {
    const { url, format = 'mp4', quality = 'best' } = req.query;
    
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    const videoId = extractVideoId(url);
    if (!videoId) {
      return res.status(400).json({ error: 'Invalid YouTube URL' });
    }

    // Generate unique filename
    const timestamp = Date.now();
    const filename = `yt_${videoId}_${timestamp}.${format}`;
    
    // Set headers
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', format === 'mp3' ? 'audio/mpeg' : 'video/mp4');
    
    // Build yt-dlp command based on format
    let command;
    if (format === 'mp3') {
      command = `yt-dlp -x --audio-format mp3 --audio-quality 320k -o - "${url}"`;
    } else {
      if (quality === 'best') {
        command = `yt-dlp -f "best[ext=mp4]" -o - "${url}"`;
      } else {
        command = `yt-dlp -f "best[height<=${quality}]" -o - "${url}"`;
      }
    }

    // Execute command and stream output
    const child = exec(command);
    
    child.stdout.pipe(res);
    
    child.stderr.on('data', (data) => {
      console.error('yt-dlp stderr:', data.toString());
    });
    
    child.on('error', (error) => {
      console.error('Exec error:', error);
      if (!res.headersSent) {
        res.status(500).send('Download failed');
      }
    });
    
    child.on('close', (code) => {
      console.log(`yt-dlp process exited with code ${code}`);
    });
    
    // Handle client disconnect
    req.on('close', () => {
      child.kill();
    });
    
  } catch (error) {
    console.error('Download error:', error);
    if (!res.headersSent) {
      res.status(500).json({ 
        success: false, 
        error: 'Download failed',
        message: error.message 
      });
    }
  }
});

// Alternative: Direct Stream (No conversion)
app.get('/api/stream', async (req, res) => {
  try {
    const { url } = req.query;
    
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    // Get direct link using yt-dlp
    const { stdout } = await execAsync(`yt-dlp -g "${url}"`);
    const streamUrl = stdout.trim().split('\n')[0];
    
    if (!streamUrl) {
      throw new Error('Could not get stream URL');
    }
    
    // Redirect to direct stream
    res.redirect(streamUrl);
  } catch (error) {
    console.error('Stream error:', error);
    res.status(500).json({ error: 'Stream failed' });
  }
});

// Helper Functions
function extractVideoId(url) {
  const patterns = [
    /(?:v=|youtu\.be\/|shorts\/)([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/
  ];
  
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match && match[1]) {
      return match[1];
    }
  }
  return null;
}

function formatDuration(seconds) {
  if (!seconds) return 'Unknown';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

function formatFileSize(bytes) {
  if (!bytes) return 'Unknown';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unitIndex = 0;
  
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }
  
  return `${size.toFixed(1)} ${units[unitIndex]}`;
}

async function getInfoFromAPI(videoId) {
  try {
    const response = await axios.get(`https://noembed.com/embed`, {
      params: { url: `https://youtube.com/watch?v=${videoId}` }
    });
    
    return {
      id: videoId,
      title: response.data.title,
      thumbnail: response.data.thumbnail_url,
      duration: 'Unknown',
      channel: response.data.author_name,
      view_count: null,
      formats: []
    };
  } catch {
    return {
      id: videoId,
      title: 'YouTube Video',
      thumbnail: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
      duration: 'Unknown',
      channel: 'Unknown',
      view_count: null,
      formats: []
    };
  }
}

// Start Server
app.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🌐 CORS enabled for Vercel`);
  
  // Check yt-dlp
  const ytDlpInstalled = await checkYtDlp();
  if (!ytDlpInstalled) {
    console.warn('⚠️  yt-dlp may not work properly');
  }
});
