import express from "express";
import ytdl from "@distube/ytdl-core";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

app.get("/", (req, res) => res.send("System Active ✅"));

app.get("/download", async (req, res) => {
    const { videoId, type } = req.query;
    if (!videoId) return res.status(400).send("ID Missing");

    const url = `https://www.youtube.com/watch?v=${videoId}`;
    
    // Bot detection se bachne ke liye Headers
    const requestOptions = {
        headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.5",
            "Connection": "keep-alive",
        }
    };

    try {
        const info = await ytdl.getInfo(url, { requestOptions });
        const title = info.videoDetails.title.replace(/[^\w\s]/gi, '');

        if (type === "mp4") {
            res.setHeader("Content-Disposition", `attachment; filename="${title}.mp4"`);
            ytdl(url, { 
                quality: 'highest', 
                filter: 'audioandvideo',
                requestOptions 
            }).pipe(res);
        } else {
            res.setHeader("Content-Disposition", `attachment; filename="${title}.mp3"`);
            ytdl(url, { 
                filter: 'audioonly', 
                quality: 'highestaudio',
                requestOptions 
            }).pipe(res);
        }
    } catch (err) {
        console.error("Critical Error:", err.message);
        res.status(500).send(`Server Busy: YouTube is currently limiting requests. Please try again in 30 seconds.`);
    }
});

app.listen(PORT, () => console.log(`Live: ${PORT}`));
