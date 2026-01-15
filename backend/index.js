import express from "express";
import ytdl from "@distube/ytdl-core";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

// Health Check & Wake up endpoint
app.get("/", (req, res) => {
  res.send("Server Awake ✅");
});

app.get("/download", async (req, res) => {
  const { videoId, type } = req.query;
  if (!videoId) return res.status(400).send("No Video ID");

  const url = `https://www.youtube.com/watch?v=${videoId}`;
  
  try {
    const info = await ytdl.getInfo(url);
    const title = info.videoDetails.title.replace(/[^\w\s]/gi, '');

    if (type === "mp4") {
      res.setHeader("Content-Disposition", `attachment; filename="${title}.mp4"`);
      ytdl(url, { quality: 'highest', filter: 'audioandvideo' }).pipe(res);
    } else {
      res.setHeader("Content-Disposition", `attachment; filename="${title}.mp3"`);
      ytdl(url, { filter: 'audioonly', quality: 'highestaudio' }).pipe(res);
    }
  } catch (err) {
    console.error(err);
    res.status(500).send("Extraction Failed");
  }
});

app.listen(PORT, () => console.log(`Backend running on ${PORT}`));
