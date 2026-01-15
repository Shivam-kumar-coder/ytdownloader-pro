import express from "express";
import ytdl from "@distube/ytdl-core";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

// Health Check (Frontend इसे लोड होते ही पिंग करेगा)
app.get("/", (req, res) => res.send("Server Ready ✅"));

app.get("/download", async (req, res) => {
    const { videoId, type } = req.query;
    if (!videoId) return res.status(400).send("No Video ID");

    const url = `https://www.youtube.com/watch?v=${videoId}`;
    
    try {
        const info = await ytdl.getInfo(url);
        // टाइटल से स्पेशल करैक्टर हटाना ताकि डाउनलोड एरर न आये
        const title = info.videoDetails.title.replace(/[^\w\s]/gi, '');

        if (type === "mp4") {
            res.setHeader("Content-Disposition", `attachment; filename="${title}.mp4"`);
            ytdl(url, { quality: 'highest', filter: 'audioandvideo' }).pipe(res);
        } else {
            res.setHeader("Content-Disposition", `attachment; filename="${title}.mp3"`);
            ytdl(url, { filter: 'audioonly', quality: 'highestaudio' }).pipe(res);
        }
    } catch (err) {
        console.error("Error:", err.message);
        res.status(500).send("Extraction Failed - YouTube might be blocking.");
    }
});

app.listen(PORT, () => console.log(`Backend live on port ${PORT}`));
