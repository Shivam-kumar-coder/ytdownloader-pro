import express from "express";
import ytdl from "@distube/ytdl-core";
import ffmpeg from "fluent-ffmpeg";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";

const app = express();
const PORT = process.env.PORT || 3000;

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

// CORS
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  next();
});

// Health check
app.get("/", (req, res) => {
  res.send("YTDownloader Backend is running ✅");
});

// DOWNLOAD API
app.get("/download", async (req, res) => {
  const { videoId, type } = req.query;

  if (!videoId) {
    return res.status(400).send("Missing videoId");
  }

  const url = `https://www.youtube.com/watch?v=${videoId}`;

  try {
    if (type === "mp4") {
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${videoId}.mp4"`
      );
      res.setHeader("Content-Type", "video/mp4");

      ytdl(url, { quality: "highest" }).pipe(res);
    }

    else if (type === "mp3") {
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${videoId}.mp3"`
      );
      res.setHeader("Content-Type", "audio/mpeg");

      const audioStream = ytdl(url, {
        filter: "audioonly",
        quality: "highestaudio"
      });

      ffmpeg(audioStream)
        .audioBitrate(128)
        .format("mp3")
        .pipe(res);
    }

    else {
      res.status(400).send("Invalid type");
    }
  } catch (err) {
    console.error(err);
    res.status(500).send("Download failed");
  }
});

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
