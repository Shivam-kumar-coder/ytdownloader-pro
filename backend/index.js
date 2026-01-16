import express from 'express';
import cors from 'cors';
import axios from 'axios';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Temporary storage cleanup
const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir);
}

// Clean temp files every hour
setInterval(() => {
  fs.readdir(tempDir, (err, files) => {
    if (err) return;
    files.forEach(file => {
      const filePath = path.join(tempDir, file);
      const stats = fs.statSync(filePath);
      const now = new Date().getTime();
      const fileAge = (now - stats.mtime.getTime()) / (1000 * 60 * 60); // hours
      
      if (fileAge > 1) { // Delete files older than 1 hour
        fs.unlinkSync(filePath);
      }
    });
  });
}, 60 * 60 * 1000);

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'running',
    service: 'YTDownloader API',
    version: '1.0.0'
  });
});

// Get video info
app.get('/info', async (req, res) => {
  try {
    const { videoId } = req.query;
    
    if (!videoId) {
      return res.status(400).json({ error: 'Missing videoId' });
    }

    // Method 1: Try YouTube API
    const info = await getVideoInfo(videoId);
    
    res.json(info);
  } catch (error) {
    console.error('Info error:', error);
    res.status(500).json({ error: 'Failed to get video info' });
  }
});

// Download endpoint
app.get('/download', async (req, res) => {
  const { videoId, type = 'mp4', quality } = req.query;
  
  if (!videoId) {
    return res.status(400).send('Missing videoId');
  }

  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const timestamp = Date.now();
  const tempFile = path.join(tempDir, `${videoId}_${timestamp}`);
  
  try {
    if (type === 'mp4') {
      await downloadVideo(url, tempFile, quality, res);
    } else if (type === 'mp3') {
      await downloadAudio(url, tempFile, res);
    } else {
      return res.status(400).send('Invalid type. Use mp4 or mp3');
    }
  } catch (error) {
    console.error('Download error:', error);
    
    // Try alternative method if first fails
    try {
      await downloadWithAlternativeMethod(url, type, videoId, res);
    } catch (altError) {
      res.status(500).send('Download failed. YouTube may have blocked this video.');
    }
  }
});

// Helper Functions

async function getVideoInfo(videoId) {
  // Try multiple methods to get video info
  const methods = [
    getInfoFromInvidious,
    getInfoFromYoutubei,
    getInfoWithYtDlp
  ];

  for (const method of methods) {
    try {
      const info = await method(videoId);
      if (info) return info;
    } catch (error) {
      console.log(`Method ${method.name} failed:`, error.message);
    }
  }
  
  throw new Error('Could not fetch video info');
}

async function getInfoFromInvidious(videoId) {
  const instances = [
    'https://vid.puffyan.us',
    'https://invidious.fdn.fr',
    'https://yt.artemislena.eu'
  ];

  for (const instance of instances) {
    try {
      const response = await axios.get(`${instance}/api/v1/videos/${videoId}`, {
        timeout: 5000
      });
      
      return {
        title: response.data.title,
        thumbnail: response.data.videoThumbnails[3]?.url || response.data.videoThumbnails[0]?.url,
        duration: formatDuration(response.data.lengthSeconds),
        channel: response.data.author
      };
    } catch (error) {
      continue;
    }
  }
  throw new Error('All invidious instances failed');
}

async function getInfoFromYoutubei(videoId) {
  const payload = {
    videoId: videoId,
    context: {
      client: {
        clientName: "WEB",
        clientVersion: "2.20231219.01.00",
        hl: "en",
        gl: "US"
      }
    }
  };

  const response = await axios.post(
    'https://www.youtube.com/youtubei/v1/player',
    payload,
    {
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    }
  );

  const data = response.data;
  return {
    title: data.videoDetails.title,
    thumbnail: data.videoDetails.thumbnail.thumbnails.pop().url,
    duration: formatDuration(data.videoDetails.lengthSeconds),
    channel: data.videoDetails.author
  };
}

async function getInfoWithYtDlp(videoId) {
  return new Promise((resolve, reject) => {
    const ytDlp = spawn('yt-dlp', [
      '--skip-download',
      '--dump-json',
      `https://www.youtube.com/watch?v=${videoId}`
    ]);

    let output = '';
    ytDlp.stdout.on('data', data => output += data);
    ytDlp.stderr.on('data', data => console.error(data.toString()));

    ytDlp.on('close', code => {
      if (code === 0) {
        try {
          const info = JSON.parse(output);
          resolve({
            title: info.title,
            thumbnail: info.thumbnail,
            duration: formatDuration(info.duration),
            channel: info.uploader
          });
        } catch (error) {
          reject(error);
        }
      } else {
        reject(new Error(`yt-dlp exited with code ${code}`));
      }
    });
  });
}

async function downloadVideo(url, tempFile, quality, res) {
  return new Promise((resolve, reject) => {
    const args = [
      '-f', quality ? `best[height<=${quality}]` : 'best[ext=mp4]',
      '-o', `${tempFile}.%(ext)s`,
      '--merge-output-format', 'mp4',
      url
    ];

    const ytDlp = spawn('yt-dlp', args);
    
    ytDlp.stderr.on('data', data => console.log(data.toString()));
    
    ytDlp.on('close', code => {
      if (code === 0) {
        const outputFile = `${tempFile}.mp4`;
        if (fs.existsSync(outputFile)) {
          res.setHeader('Content-Disposition', `attachment; filename="video_${Date.now()}.mp4"`);
          res.setHeader('Content-Type', 'video/mp4');
          
          const fileStream = fs.createReadStream(outputFile);
          fileStream.pipe(res);
          
          fileStream.on('end', () => {
            fs.unlinkSync(outputFile);
            resolve();
          });
          
          fileStream.on('error', reject);
        } else {
          reject(new Error('Output file not found'));
        }
      } else {
        reject(new Error(`yt-dlp failed with code ${code}`));
      }
    });
  });
}

async function downloadAudio(url, tempFile, res) {
  return new Promise((resolve, reject) => {
    const args = [
      '-x',
      '--audio-format', 'mp3',
      '--audio-quality', '0',
      '-o', `${tempFile}.%(ext)s`,
      url
    ];

    const ytDlp = spawn('yt-dlp', args);
    
    ytDlp.stderr.on('data', data => console.log(data.toString()));
    
    ytDlp.on('close', code => {
      if (code === 0) {
        const outputFile = `${tempFile}.mp3`;
        if (fs.existsSync(outputFile)) {
          res.setHeader('Content-Disposition', `attachment; filename="audio_${Date.now()}.mp3"`);
          res.setHeader('Content-Type', 'audio/mpeg');
          
          const fileStream = fs.createReadStream(outputFile);
          fileStream.pipe(res);
          
          fileStream.on('end', () => {
            fs.unlinkSync(outputFile);
            resolve();
          });
          
          fileStream.on('error', reject);
        } else {
          reject(new Error('Output file not found'));
        }
      } else {
        reject(new Error(`yt-dlp failed with code ${code}`));
      }
    });
  });
}

async function downloadWithAlternativeMethod(url, type, videoId, res) {
  // Fallback method using external API
  const apis = [
    `https://api.vevioz.com/api/button/${type}/${videoId}`,
    `https://yt5s.io/api/ajaxSearch`,
    `https://loader.to/ajax/download.php`
  ];

  for (const api of apis) {
    try {
      const response = await axios.post(api, {
        url: url,
        format: type === 'mp4' ? 'mp4' : 'mp3'
      }, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });

      if (response.data.downloadUrl) {
        return res.redirect(response.data.downloadUrl);
      }
    } catch (error) {
      continue;
    }
  }
  
  throw new Error('All alternative methods failed');
}

function formatDuration(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Temp directory: ${tempDir}`);
});
