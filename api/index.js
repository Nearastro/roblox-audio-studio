const express = require("express");
const cors = require("cors");
const ytdl = require("@distube/ytdl-core");
const ffmpegPath = require("@ffmpeg-installer/ffmpeg").path;
const ffmpeg = require("fluent-ffmpeg");
const fs = require("fs");
const path = require("path");
const os = require("os");

ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
app.use(cors());
app.use(express.json());

const tmpDir = os.tmpdir();

// 0. Route Halaman Utama (Serves index.html langsung dari Root Vercel)
app.get("/", (req, res) => {
  const htmlPath = path.join(__dirname, "../index.html");
  if (fs.existsSync(htmlPath)) {
    res.sendFile(htmlPath);
  } else {
    res.send("Roblox Audio Studio Backend Active. index.html tidak ditemukan di root.");
  }
});

// 1. Fetch Info YT
app.post("/api/yt-info", async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: "URL wajib diisi" });

    const info = await ytdl.getInfo(url);
    const details = info.videoDetails;

    res.json({
      title: details.title,
      thumbnail: details.thumbnails[details.thumbnails.length - 1].url,
      duration: details.lengthSeconds
    });
  } catch (err) {
    res.status(500).json({ error: "Gagal mengambil info YouTube", details: err.message });
  }
});

// 2. Proxy Avatar / Group Logo Roblox
app.get("/api/roblox-icon", async (req, res) => {
  try {
    const { type, id } = req.query;
    if (!id) return res.status(400).json({ error: "ID required" });

    let robloxUrl = type === "Group"
      ? `https://thumbnails.roblox.com/v1/groups/icons?groupIds=${id}&size=150x150&format=Png`
      : `https://thumbnails.roblox.com/v1/users/avatar-headshots?userIds=${id}&size=150x150&format=Png&isCircular=false`;

    const response = await fetch(robloxUrl);
    const data = await response.json();
    const imageUrl = data.data?.[0]?.imageUrl || "https://tr.rbxcdn.com/30day-avatar-headshot";

    res.json({ imageUrl });
  } catch (err) {
    res.json({ imageUrl: "https://tr.rbxcdn.com/30day-avatar-headshot" });
  }
});

// 3. Process Audio (Cut, Speed & Fix Volume -4dB)
app.post("/api/process-audio", async (req, res) => {
  try {
    const { url, duration = 350, speed = 2.3 } = req.body;
    const id = Date.now();
    const rawPath = path.join(tmpDir, `raw_${id}.mp3`);
    const outputPath = path.join(tmpDir, `processed_${id}.mp3`);

    // Download Stream YT
    const stream = ytdl(url, { filter: "audioonly", quality: "highestaudio" });
    const writeStream = fs.createWriteStream(rawPath);
    stream.pipe(writeStream);

    await new Promise((resolve, reject) => {
      writeStream.on("finish", resolve);
      writeStream.on("error", reject);
    });

    // FFmpeg Processing
    await new Promise((resolve, reject) => {
      ffmpeg(rawPath)
        .setDuration(parseFloat(duration))
        .audioFilters([
          `atempo=${speed}`,
          `volume=-4dB`
        ])
        .output(outputPath)
        .on("end", resolve)
        .on("error", reject)
        .run();
    });

    if (fs.existsSync(rawPath)) fs.unlinkSync(rawPath);

    // Read base64
    const fileBuffer = fs.readFileSync(outputPath);
    const base64Audio = fileBuffer.toString("base64");
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);

    res.json({
      base64Data: base64Audio,
      tempId: id
    });
  } catch (err) {
    res.status(500).json({ error: "Gagal memproses audio", details: err.message });
  }
});

// 4. Upload to Roblox via API Key
app.post("/api/upload-roblox", async (req, res) => {
  try {
    const { apiKey, creatorType, creatorId, title, base64Data } = req.body;

    if (!base64Data) {
      return res.status(400).json({ error: "Data audio tidak ditemukan." });
    }

    let robloxDisplayName = (title || "Studio Audio").trim();
    if (robloxDisplayName.length > 45) {
      robloxDisplayName = robloxDisplayName.substring(0, 42) + "...";
    }

    const fileBuffer = Buffer.from(base64Data, "base64");
    const boundary = "----RobloxBoundary" + Math.random().toString(16).substring(2);

    const creator = creatorType === "Group" ? { groupId: creatorId } : { userId: creatorId };
    const assetRequest = {
      assetType: "Audio",
      displayName: robloxDisplayName,
      description: "Uploaded via Roblox Audio Studio",
      creationContext: { creator }
    };

    const requestJsonStr = JSON.stringify(assetRequest);

    const part1Header = `--${boundary}\r\nContent-Disposition: form-data; name="request"\r\nContent-Type: application/json\r\n\r\n${requestJsonStr}\r\n`;
    const part2Header = `--${boundary}\r\nContent-Disposition: form-data; name="fileContent"; filename="audio.mp3"\r\nContent-Type: audio/mpeg\r\n\r\n`;
    const footer = `\r\n--${boundary}--\r\n`;

    const enc = new TextEncoder();
    const p1 = enc.encode(part1Header);
    const p2 = enc.encode(part2Header);
    const f = enc.encode(footer);

    const totalLength = p1.length + p2.length + fileBuffer.length + f.length;
    const multipartBody = new Uint8Array(totalLength);

    multipartBody.set(p1, 0);
    multipartBody.set(p2, p1.length);
    multipartBody.set(fileBuffer, p1.length + p2.length);
    multipartBody.set(f, p1.length + p2.length + fileBuffer.length);

    const response = await fetch("https://apis.roblox.com/assets/v1/assets", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "Content-Type": `multipart/form-data; boundary=${boundary}`
      },
      body: multipartBody
    });

    const data = await response.json();
    if (!response.ok) return res.status(response.status).json(data);

    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const opRes = await fetch(`https://apis.roblox.com/assets/v1/${data.path.replace(/^\/+/, "")}`, {
        headers: { "x-api-key": apiKey }
      });
      const opData = await opRes.json();

      if (opData.done) {
        return res.json({ assetId: opData.response?.assetId });
      }
    }

    res.status(408).json({ error: "Timeout memproses asset di Roblox." });
  } catch (err) {
    res.status(500).json({ error: "Upload gagal", details: err.message });
  }
});

module.exports = app;
