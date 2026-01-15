const express = require('express');
const ytdl = require('ytdl-core');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Store temporary info (simple cache)
const videoCache = new Map();

// ==================== HELPER FUNCTIONS ====================
function formatDuration(seconds) {
    if (!seconds || seconds === "Unknown") return "Unknown";
    
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    
    if (hrs > 0) {
        return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    } else {
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    }
}

async function getVideoInfoFallback(videoId) {
    try {
        const response = await axios.get(`https://noembed.com/embed?url=https://youtube.com/watch?v=${videoId}`);
        
        return {
            success: true,
            video: {
                id: videoId,
                title: response.data.title,
                thumbnail: `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
                duration: "Unknown",
                channel: response.data.author_name
            },
            formats: {
                mp4: [
                    { quality: "720p", itag: "22", size: "~50MB" },
                    { quality: "360p", itag: "18", size: "~25MB" }
                ],
                mp3: [
                    { quality: "128kbps", itag: "140", size: "~5MB" }
                ]
            }
        };
    } catch (error) {
        throw error;
    }
}

// ==================== ROUTES ====================

// Health Check & Wake up endpoint
app.get('/', (req, res) => {
    res.json({ 
        status: 'active', 
        message: 'YouTube Downloader Backend',
        timestamp: new Date().toISOString(),
        endpoints: {
            info: '/api/info?videoId=VIDEO_ID',
            download: '/download?videoId=VIDEO_ID&type=mp4',
            direct: '/direct?videoId=VIDEO_ID&type=mp3',
            ping: '/ping'
        }
    });
});

// Ping endpoint to keep server awake
app.get('/ping', (req, res) => {
    res.json({ 
        status: 'pong', 
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        timestamp: new Date().toISOString()
    });
});

// Get video info endpoint
app.get('/api/info', async (req, res) => {
    try {
        const { videoId } = req.query;
        
        if (!videoId) {
            return res.status(400).json({ error: 'Video ID required' });
        }

        const url = `https://www.youtube.com/watch?v=${videoId}`;
        
        // Get video info
        const info = await ytdl.getInfo(url, {
            requestOptions: {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept-Language': 'en-US,en;q=0.9'
                }
            }
        });

        const videoDetails = {
            id: videoId,
            title: info.videoDetails.title,
            duration: info.videoDetails.lengthSeconds,
            thumbnail: info.videoDetails.thumbnails[info.videoDetails.thumbnails.length - 1].url,
            channel: info.videoDetails.author.name,
            views: info.videoDetails.viewCount
        };

        // Get available formats
        const formats = info.formats.filter(f => f.hasVideo || f.hasAudio);
        
        // MP4 formats
        const mp4Formats = formats
            .filter(f => f.container === 'mp4' && f.hasVideo && f.hasAudio)
            .map(f => ({
                quality: f.qualityLabel || 'Unknown',
                itag: f.itag,
                size: f.contentLength ? `${Math.round(f.contentLength / (1024 * 1024))}MB` : 'Unknown',
                codec: f.codecs || 'Unknown'
            }))
            .slice(0, 3);

        // Audio formats
        const audioFormats = formats
            .filter(f => f.hasAudio && !f.hasVideo)
            .map(f => ({
                quality: f.audioBitrate ? `${f.audioBitrate}kbps` : 'Audio',
                itag: f.itag,
                size: f.contentLength ? `${Math.round(f.contentLength / (1024 * 1024))}MB` : 'Unknown'
            }))
            .slice(0, 2);

        // Cache the info
        videoCache.set(videoId, {
            info: info,
            mp4Formats,
            audioFormats,
            timestamp: Date.now()
        });

        // Clear cache after 10 minutes
        setTimeout(() => {
            videoCache.delete(videoId);
        }, 10 * 60 * 1000);

        res.json({
            success: true,
            video: videoDetails,
            formats: {
                mp4: mp4Formats,
                mp3: audioFormats
            }
        });

    } catch (error) {
        console.error('Error fetching video info:', error.message);
        
        // Try fallback
        try {
            const fallbackInfo = await getVideoInfoFallback(req.query.videoId);
            return res.json(fallbackInfo);
        } catch (fallbackError) {
            console.error('Fallback also failed:', fallbackError.message);
            
            res.status(500).json({ 
                error: 'Failed to fetch video info',
                message: error.message,
                suggestion: 'Try again or use alternative services'
            });
        }
    }
});

// Direct download endpoint (Main)
app.get('/download', async (req, res) => {
    try {
        const { videoId, type = 'mp4', quality = 'highest' } = req.query;
        
        if (!videoId) {
            return res.status(400).send('Video ID is required');
        }

        const url = `https://www.youtube.com/watch?v=${videoId}`;
        
        // Get video info
        const info = await ytdl.getInfo(url);
        const title = info.videoDetails.title
            .replace(/[^\w\s]/gi, '')
            .replace(/\s+/g, '_')
            .substring(0, 100);

        // Set headers
        if (type === 'mp4') {
            res.setHeader('Content-Type', 'video/mp4');
            res.setHeader('Content-Disposition', `attachment; filename="${title}.mp4"`);
            
            // Stream video
            ytdl(url, { 
                quality: quality === 'highest' ? 'highest' : quality,
                filter: format => format.container === 'mp4' && format.hasVideo && format.hasAudio
            }).pipe(res);
            
        } else if (type === 'mp3') {
            res.setHeader('Content-Type', 'audio/mpeg');
            res.setHeader('Content-Disposition', `attachment; filename="${title}.mp3"`);
            
            // Stream audio
            ytdl(url, { 
                filter: 'audioonly',
                quality: 'highestaudio'
            }).pipe(res);
            
        } else {
            return res.status(400).send("Invalid type. Use 'mp4' or 'mp3'");
        }

    } catch (error) {
        console.error('Download error:', error.message);
        
        // Redirect to alternative service
        const videoId = req.query.videoId;
        const type = req.query.type || 'mp4';
        
        if (type === 'mp4') {
            res.redirect(`https://www.y2mate.com/youtube/${videoId}`);
        } else {
            res.redirect(`https://www.y2mate.com/youtube-mp3/${videoId}`);
        }
    }
});

// Simple download endpoint (Fallback)
app.get('/direct', async (req, res) => {
    const { videoId, type } = req.query;
    
    if (!videoId) {
        return res.status(400).send('Video ID required');
    }

    try {
        const url = `https://www.youtube.com/watch?v=${videoId}`;
        const info = await ytdl.getInfo(url);
        const title = info.videoDetails.title
            .replace(/[^\w\s]/gi, '')
            .replace(/\s+/g, ' ')
            .substring(0, 50);

        if (type === 'mp3') {
            res.setHeader('Content-Type', 'audio/mpeg');
            res.setHeader('Content-Disposition', `attachment; filename="${title}.mp3"`);
            ytdl(url, { 
                filter: 'audioonly', 
                quality: 'highestaudio' 
            }).pipe(res);
        } else {
            res.setHeader('Content-Type', 'video/mp4');
            res.setHeader('Content-Disposition', `attachment; filename="${title}.mp4"`);
            ytdl(url, { 
                quality: 'highest', 
                filter: 'audioandvideo' 
            }).pipe(res);
        }
    } catch (error) {
        console.error('Direct download error:', error);
        
        // Fallback redirect
        if (type === 'mp3') {
            res.redirect(`https://yt5s.com/en?q=https://youtube.com/watch?v=${videoId}`);
        } else {
            res.redirect(`https://ssyoutube.com/watch?v=${videoId}`);
        }
    }
});

// Alternative services endpoint
app.get('/alternatives', (req, res) => {
    const { videoId } = req.query;
    
    if (!videoId) {
        return res.status(400).json({ error: 'Video ID required' });
    }
    
    const alternatives = {
        y2mate: `https://www.y2mate.com/youtube/${videoId}`,
        y2mate_mp3: `https://www.y2mate.com/youtube-mp3/${videoId}`,
        ssyoutube: `https://ssyoutube.com/watch?v=${videoId}`,
        yt5s: `https://yt5s.com/en?q=https://youtube.com/watch?v=${videoId}`,
        loader: `https://loader.to/en20/download-youtube-video.html?v=${videoId}`
    };
    
    res.json({
        success: true,
        videoId: videoId,
        alternatives: alternatives
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📡 Backend URL: http://localhost:${PORT}`);
    console.log(`🕒 Started at: ${new Date().toLocaleString()}`);
    console.log(`⚡ Endpoints:`);
    console.log(`   • GET /          - Health check`);
    console.log(`   • GET /ping      - Keep alive`);
    console.log(`   • GET /api/info  - Get video info`);
    console.log(`   • GET /download  - Direct download`);
    console.log(`   • GET /direct    - Simple download`);
});