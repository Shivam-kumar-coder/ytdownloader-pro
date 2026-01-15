import express from "express";
import ytdl from "@distube/ytdl-core";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

// Wake-up endpoint
app.get("/", (req, res) => res.send("Server Awake ✅"));

app.get("/download", async (req, res) => {
    const { videoId, type } = req.query;
    if (!videoId) return res.status(400).send("Video ID is missing");

    const url = `https://www.youtube.com/watch?v=${videoId}`;
    
    try {
        const info = await ytdl.getInfo(url);
        const title = info.videoDetails.title.replace(/[^\w\s]/gi, '');

        if (type === "mp4") {
            res.setHeader("Content-Disposition", `attachment; filename="${title}.mp4"`);
            // Highest quality with both audio and video
            ytdl(url, { quality: 'highest', filter: 'audioandvideo' }).pipe(res);
        } else {
            res.setHeader("Content-Disposition", `attachment; filename="${title}.mp3"`);
            ytdl(url, { filter: 'audioonly', quality: 'highestaudio' }).pipe(res);
        }
    } catch (err) {
        console.error("Error:", err.message);
        res.status(500).send("YouTube blocked this request. Try again in a few minutes.");
    }
});

app.listen(PORT, () => console.log(`Server is running on port ${PORT}`));
