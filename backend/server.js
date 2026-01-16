import express from 'express';
import cors from 'cors';
import axios from 'axios';
import ytdl from 'ytdl-core';
import fs from 'fs';
import { pipeline } from 'stream/promises';
import { randomBytes } from 'crypto';

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({
  origin: ['https://ytdownloader-pro.vercel.app', 'http://localhost:3000'],
  credentials: true
}));

app.use(express.json());

// In-memory cache
const cache = new Map();
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    service: 'YTDownloader API',
    version: '2.0.0',
    timestamp: new Date().toISOString()
  });
});

// Get video info
app.get('/api/info', async (req, res) => {
  try {
    const { url } = req.query;
    
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    // Validate YouTube URL
    if (!ytdl.validateURL(url)) {
      return res.status(400).json({ error: 'Invalid YouTube URL' });
    }

    // Try to get from cache first
    const cacheKey = `info:${url}`;
    const cached = cache.get(cacheKey);
    
    if (cached && (Date.now() - cached.timestamp < CACHE_DURATION)) {
      return res.json({ success: true, data: cached.data, cached: true });
    }

    // Get video info using ytdl-core
    const info = await ytdl.getInfo(url);
    
    const videoInfo = {
      id: info.videoDetails.videoId,
      title: info.videoDetails.title,
      thumbnail: info.videoDetails.thumbnails[info.videoDetails.thumbnails.length - 1].url,
      duration: formatDuration(parseInt(info.videoDetails.lengthSeconds)),
      channel: info.videoDetails.author.name,
      view_count: parseInt(info.videoDetails.viewCount) || null,
      formats: info.formats.filter(f => f.hasVideo || f.hasAudio).map(format => ({
        quality: format.qualityLabel || format.audioQuality || 'Unknown',
        container: format.container,
        hasVideo: format.hasVideo,
        hasAudio: format.hasAudio,
        filesize: format.contentLength ? formatFileSize(parseInt(format.contentLength)) : 'Unknown',
        url: format.url
      }))
    };

    // Cache the result
    cache.set(cacheKey, {
      data: videoInfo,
      timestamp: Date.now()
    });

    res.json({ success: true, data: videoInfo, cached: false });
    
  } catch (error) {
    console.error('Info error:', error);
    
    // Fallback method using noembed API
    try {
      const videoId = extractVideoId(req.query.url);
      if (!videoId) throw error;
      
      const fallbackInfo = await getFallbackInfo(videoId);
      res.json({ success: true, data: fallbackInfo, fallback: true });
    } catch (fallbackError) {
      res.status(500).json({ 
        success: false, 
        error: 'Failed to get video info',
        message: error.message 
      });
    }
  }
});

// Download endpoint
app.get('/api/download', async (req, res) => {
  try {
    const { url, format = 'mp4', quality = 'highest' } = req.query;
    
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    // Validate URL
    if (!ytdl.validateURL(url)) {
      return res.status(400).json({ error: 'Invalid YouTube URL' });
    }

    // Get video info
    const info = await ytdl.getInfo(url);
    const videoId = info.videoDetails.videoId;
    
    // Set headers
    const filename = `video_${videoId}_${Date.now()}.${format === 'mp3' ? 'mp3' : 'mp4'}`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    
    if (format === 'mp3') {
      res.setHeader('Content-Type', 'audio/mpeg');
      
      // For audio, we need to use a different approach since ytdl-core doesn't convert
      // We'll use an external service or stream audio-only format
      const audioFormats = ytdl.filterFormats(info.formats, 'audioonly');
      const bestAudio = audioFormats[0];
      
      if (bestAudio && bestAudio.url) {
        // Redirect to direct audio stream
        return res.redirect(bestAudio.url);
      } else {
        // Use ytdl with audio only filter
        ytdl(url, { filter: 'audioonly', quality: 'highestaudio' })
          .pipe(res)
          .on('error', (error) => {
            console.error('Stream error:', error);
            if (!res.headersSent) {
              res.status(500).send('Download failed');
            }
          });
      }
    } else {
      res.setHeader('Content-Type', 'video/mp4');
      
      // Choose format based on quality
      let filter;
      if (quality === 'highest') {
        filter = 'videoandaudio';
      } else if (quality === 'lowest') {
        filter = 'videoandaudio';
      } else {
        filter = (format) => format.container === 'mp4' && 
          format.qualityLabel === quality + 'p';
      }
      
      const videoStream = ytdl(url, { 
        filter: filter,
        quality: quality === 'lowest' ? 'lowest' : 'highest'
      });
      
      videoStream.pipe(res);
      
      videoStream.on('error', (error) => {
        console.error('Stream error:', error);
        if (!res.headersSent) {
          res.status(500).send('Download failed');
        }
      });
    }
    
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

// Stream endpoint (for direct playback)
app.get('/api/stream', async (req, res) => {
  try {
    const { url } = req.query;
    
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    if (!ytdl.validateURL(url)) {
      return res.status(400).json({ error: 'Invalid YouTube URL' });
    }

    // Get stream URL using ytdl-core
    const info = await ytdl.getInfo(url);
    const format = ytdl.chooseFormat(info.formats, { quality: 'highest' });
    
    if (!format || !format.url) {
      return res.status(500).json({ error: 'Could not get stream URL' });
    }
    
    // Redirect to stream URL
    res.redirect(format.url);
    
  } catch (error) {
    console.error('Stream error:', error);
    res.status(500).json({ error: 'Stream failed' });
  }
});

// Alternative download using external APIs
app.get('/api/download/alt', async (req, res) => {
  try {
    const { url, format = 'mp4' } = req.query;
    
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    const videoId = extractVideoId(url);
    if (!videoId) {
      return res.status(400).json({ error: 'Invalid YouTube URL' });
    }

    // Use external APIs as fallback
    const downloadUrl = await getDownloadUrlFromExternalAPI(videoId, format);
    
    if (downloadUrl) {
      res.redirect(downloadUrl);
    } else {
      res.status(500).json({ error: 'All download methods failed' });
    }
    
  } catch (error) {
    console.error('Alt download error:', error);
    res.status(500).json({ error: 'Download failed' });
  }
});

// Helper functions
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

async function getFallbackInfo(videoId) {
  try {
    const response = await axios.get(`https://noembed.com/embed`, {
      params: { 
        url: `https://youtube.com/watch?v=${videoId}`,
        format: 'json'
      },
      timeout: 5000
    });
    
    return {
      id: videoId,
      title: response.data.title || 'YouTube Video',
      thumbnail: response.data.thumbnail_url || `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
      duration: 'Unknown',
      channel: response.data.author_name || 'Unknown',
      view_count: null,
      formats: []
    };
  } catch (error) {
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

async function getDownloadUrlFromExternalAPI(videoId, format) {
  const apis = [
    // Add free external APIs here
    `https://yt5s.io/api/ajaxSearch`,
    `https://api.vevioz.com/api/button/${format}/${videoId}`
  ];

  for (const api of apis) {
    try {
      const response = await axios.post(api, {
        q: `https://youtube.com/watch?v=${videoId}`,
        vt: format
      }, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        timeout: 10000
      });

      if (response.data && response.data.d_url) {
        return response.data.d_url;
      }
    } catch (error) {
      console.log(`API ${api} failed:`, error.message);
      continue;
    }
  }
  
  return null;
}

// Clean cache every hour
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of cache.entries()) {
    if (now - value.timestamp > CACHE_DURATION) {
      cache.delete(key);
    }
  }
}, 60 * 60 * 1000);

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📁 Cache enabled with ${CACHE_DURATION/1000} second duration`);
});
