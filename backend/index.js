import express from 'express';
import cors from 'cors';
import ytdl from 'ytdl-core';
import axios from 'axios';

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({
  origin: ['https://ytdownloader-pro.vercel.app', 'http://localhost:3000', '*'],
  credentials: true
}));
app.use(express.json());

// Cache for video info
const videoCache = new Map();
const CACHE_DURATION = 10 * 60 * 1000; // 10 minutes

// Health check endpoint
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'YTDownloader Pro Backend',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    endpoints: {
      info: 'GET /api/info?url=YOUTUBE_URL',
      download: 'GET /api/download?url=YOUTUBE_URL&type=mp4/mp3',
      stream: 'GET /api/stream?url=YOUTUBE_URL'
    }
  });
});

// Get video info
app.get('/api/info', async (req, res) => {
  try {
    const { url } = req.query;
    
    if (!url) {
      return res.status(400).json({ 
        success: false, 
        error: 'YouTube URL is required' 
      });
    }

    // Validate YouTube URL
    if (!ytdl.validateURL(url)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid YouTube URL' 
      });
    }

    const videoId = extractVideoId(url);
    const cacheKey = `info_${videoId}`;
    
    // Check cache
    if (videoCache.has(cacheKey)) {
      const cached = videoCache.get(cacheKey);
      if (Date.now() - cached.timestamp < CACHE_DURATION) {
        return res.json({ 
          success: true, 
          data: cached.data, 
          cached: true 
        });
      }
    }

    // Get video info using ytdl-core
    const info = await ytdl.getInfo(url);
    
    // Extract available formats
    const videoFormats = info.formats
      .filter(f => f.hasVideo && f.hasAudio && f.container === 'mp4')
      .map(f => ({
        quality: f.qualityLabel || `${f.height}p`,
        container: f.container,
        size: f.contentLength ? formatBytes(f.contentLength) : 'Unknown',
        fps: f.fps,
        codec: f.codecs
      }))
      .sort((a, b) => {
        const aHeight = parseInt(a.quality) || 0;
        const bHeight = parseInt(b.quality) || 0;
        return bHeight - aHeight;
      });

    const audioFormats = info.formats
      .filter(f => f.hasAudio && !f.hasVideo)
      .map(f => ({
        quality: f.audioBitrate ? `${f.audioBitrate}kbps` : 'Unknown',
        container: f.container,
        size: f.contentLength ? formatBytes(f.contentLength) : 'Unknown',
        codec: f.codecs
      }))
      .sort((a, b) => {
        const aBitrate = parseInt(a.quality) || 0;
        const bBitrate = parseInt(b.quality) || 0;
        return bBitrate - aBitrate;
      });

    const videoInfo = {
      id: videoId,
      title: info.videoDetails.title,
      thumbnail: info.videoDetails.thumbnails[info.videoDetails.thumbnails.length - 1].url,
      duration: formatDuration(info.videoDetails.lengthSeconds),
      channel: info.videoDetails.author.name,
      views: parseInt(info.videoDetails.viewCount).toLocaleString(),
      uploadDate: info.videoDetails.uploadDate,
      formats: {
        video: videoFormats.slice(0, 5), // Top 5 video formats
        audio: audioFormats.slice(0, 3)  // Top 3 audio formats
      }
    };

    // Cache the result
    videoCache.set(cacheKey, {
      data: videoInfo,
      timestamp: Date.now()
    });

    res.json({ 
      success: true, 
      data: videoInfo,
      cached: false 
    });

  } catch (error) {
    console.error('Info error:', error);
    
    // Fallback to external API
    try {
      const videoId = extractVideoId(req.query.url);
      if (!videoId) throw error;
      
      const fallbackInfo = await getFallbackInfo(videoId);
      res.json({ 
        success: true, 
        data: fallbackInfo,
        fallback: true 
      });
    } catch (fallbackError) {
      res.status(500).json({ 
        success: false, 
        error: 'Failed to get video information',
        message: error.message 
      });
    }
  }
});

// Download endpoint
app.get('/api/download', async (req, res) => {
  try {
    const { url, type = 'mp4', quality = 'highest' } = req.query;
    
    if (!url) {
      return res.status(400).send('YouTube URL is required');
    }

    if (!ytdl.validateURL(url)) {
      return res.status(400).send('Invalid YouTube URL');
    }

    const videoId = extractVideoId(url);
    const filename = `yt_${videoId}_${Date.now()}.${type}`;
    
    // Set headers
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    
    if (type === 'mp3') {
      res.setHeader('Content-Type', 'audio/mpeg');
      
      // Download audio
      const audioStream = ytdl(url, {
        filter: 'audioonly',
        quality: 'highestaudio',
        highWaterMark: 1 << 25 // 32MB buffer
      });
      
      audioStream.pipe(res);
      
      audioStream.on('error', (error) => {
        console.error('Audio stream error:', error);
        if (!res.headersSent) {
          res.status(500).send('Audio download failed');
        }
      });
      
    } else if (type === 'mp4') {
      res.setHeader('Content-Type', 'video/mp4');
      
      // Choose quality
      let filter = 'videoandaudio';
      let qualityOption = 'highest';
      
      if (quality === '360') {
        filter = (format) => format.container === 'mp4' && format.height === 360;
      } else if (quality === '720') {
        filter = (format) => format.container === 'mp4' && format.height === 720;
      } else if (quality === '1080') {
        filter = (format) => format.container === 'mp4' && format.height === 1080;
      }
      
      // Download video
      const videoStream = ytdl(url, {
        filter: filter,
        quality: qualityOption,
        highWaterMark: 1 << 25 // 32MB buffer
      });
      
      videoStream.pipe(res);
      
      videoStream.on('error', (error) => {
        console.error('Video stream error:', error);
        if (!res.headersSent) {
          res.status(500).send('Video download failed');
        }
      });
      
    } else {
      return res.status(400).send('Invalid type. Use mp4 or mp3');
    }
    
    // Handle client disconnect
    req.on('close', () => {
      console.log('Client disconnected from download');
    });
    
  } catch (error) {
    console.error('Download error:', error);
    if (!res.headersSent) {
      res.status(500).send('Download failed. Please try again.');
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

    // Get stream URL
    const info = await ytdl.getInfo(url);
    const format = ytdl.chooseFormat(info.formats, { 
      quality: 'highest',
      filter: 'videoandaudio'
    });
    
    if (!format || !format.url) {
      return res.status(500).json({ error: 'Could not get stream URL' });
    }
    
    // Redirect to stream
    res.redirect(format.url);
    
  } catch (error) {
    console.error('Stream error:', error);
    res.status(500).json({ error: 'Stream failed' });
  }
});

// Alternative download using external service
app.get('/api/download/alt', async (req, res) => {
  try {
    const { url, type = 'mp4' } = req.query;
    const videoId = extractVideoId(url);
    
    if (!videoId) {
      return res.status(400).json({ error: 'Invalid URL' });
    }

    // Use yt5s.io API
    const apiUrl = 'https://yt5s.io/api/ajaxSearch';
    
    const response = await axios.post(apiUrl, 
      new URLSearchParams({
        q: `https://www.youtube.com/watch?v=${videoId}`,
        vt: type
      }), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      }
    );

    if (response.data && response.data.vid) {
      const convertUrl = 'https://yt5s.io/api/ajaxConvert';
      
      const convertResponse = await axios.post(convertUrl,
        new URLSearchParams({
          vid: response.data.vid,
          k: response.data.links.mp4[type === 'mp4' ? 'auto' : '140'].k
        }), {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        }
      );

      if (convertResponse.data && convertResponse.data.d_url) {
        return res.redirect(convertResponse.data.d_url);
      }
    }
    
    res.status(500).json({ error: 'External service failed' });
    
  } catch (error) {
    console.error('Alt download error:', error);
    res.status(500).json({ error: 'Alternative download failed' });
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
  if (!seconds) return '0:00';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

async function getFallbackInfo(videoId) {
  try {
    const response = await axios.get('https://noembed.com/embed', {
      params: { 
        url: `https://www.youtube.com/watch?v=${videoId}`,
        format: 'json'
      },
      timeout: 5000
    });
    
    return {
      id: videoId,
      title: response.data.title || 'YouTube Video',
      thumbnail: response.data.thumbnail_url || `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
      duration: 'Unknown',
      channel: response.data.author_name || 'Unknown Channel',
      views: 'Unknown',
      uploadDate: 'Unknown',
      formats: {
        video: [
          { quality: '360p', container: 'mp4', size: '~50-100 MB' },
          { quality: '720p', container: 'mp4', size: '~100-250 MB' },
          { quality: '1080p', container: 'mp4', size: '~250-500 MB' }
        ],
        audio: [
          { quality: '128kbps', container: 'mp3', size: '~5-10 MB' },
          { quality: '192kbps', container: 'mp3', size: '~7-15 MB' },
          { quality: '320kbps', container: 'mp3', size: '~10-25 MB' }
        ]
      }
    };
  } catch (error) {
    // Return basic info
    return {
      id: videoId,
      title: 'YouTube Video',
      thumbnail: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
      duration: 'Unknown',
      channel: 'Unknown Channel',
      views: 'Unknown',
      uploadDate: 'Unknown',
      formats: {
        video: [
          { quality: '360p', container: 'mp4', size: '~50-100 MB' },
          { quality: '720p', container: 'mp4', size: '~100-250 MB' },
          { quality: '1080p', container: 'mp4', size: '~250-500 MB' }
        ],
        audio: [
          { quality: '128kbps', container: 'mp3', size: '~5-10 MB' },
          { quality: '192kbps', container: 'mp3', size: '~7-15 MB' },
          { quality: '320kbps', container: 'mp3', size: '~10-25 MB' }
        ]
      }
    };
  }
}

// Clean cache every hour
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of videoCache.entries()) {
    if (now - value.timestamp > CACHE_DURATION) {
      videoCache.delete(key);
    }
  }
  console.log(`Cache cleaned. Current size: ${videoCache.size}`);
}, 60 * 60 * 1000);

// Start server
app.listen(PORT, () => {
  console.log(`✅ YTDownloader Backend is running on port ${PORT}`);
  console.log(`🌐 Server URL: http://localhost:${PORT}`);
  console.log(`📊 Cache enabled (${CACHE_DURATION/1000} seconds)`);
  console.log(`🚀 Ready to download YouTube videos!`);
});
