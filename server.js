const express = require("express");
const cors = require("cors");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const util = require("util");

const execPromise = util.promisify(exec);
const app = express();

app.use(cors());
app.use(express.json());
app.use("/downloads", express.static(path.join(__dirname, "downloads")));

if (!fs.existsSync("downloads")) {
  fs.mkdirSync("downloads");
}

// 1. Fetch Info YT (Title & Thumbnail)
app.post("/api/yt-info", async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: "URL wajib diisi" });

    const { stdout } = await execPromise(`yt-dlp --dump-json "${url}"`);
    const info = JSON.parse(stdout);

    res.json({
      title: info.title,
      thumbnail: info.thumbnail,
      duration: info.duration
    });
  } catch (err) {
    res.status(500).json({ error: "Gagal mengambil info YouTube", details: err.message });
  }
});

// 2. Proxy Avatar / Group Logo dari Roblox (Mencegah CORS)
app.get("/api/roblox-icon", async (req, res) => {
  try {
    const { type, id } = req.query;
    if (!id) return res.status(400).json({ error: "ID required" });

    let robloxUrl = "";
    if (type === "Group") {
      robloxUrl = `https://thumbnails.roblox.com/v1/groups/icons?groupIds=${id}&size=150x150&format=Png`;
    } else {
      robloxUrl = `https://thumbnails.roblox.com/v1/users/avatar-headshots?userIds=${id}&size=150x150&format=Png&isCircular=false`;
    }

    const response = await fetch(robloxUrl);
    const data = await response.json();
    const imageUrl = data.data?.[0]?.imageUrl || "https://tr.rbxcdn.com/30day-avatar-headshot";

    res.json({ imageUrl });
  } catch (err) {
    res.json({ imageUrl: "https://tr.rbxcdn.com/30day-avatar-headshot" });
  }
});

// 3. Process Audio (yt-dlp + ffmpeg)
app.post("/api/process-audio", async (req, res) => {
  try {
    const { url, duration = 350, speed = 2.3 } = req.body;
    const id = Date.now();
    const rawPath = path.join(__dirname, "downloads", `raw_${id}.mp3`);
    const outputPath = path.join(__dirname, "downloads", `processed_${id}.mp3`);

    await execPromise(`yt-dlp -x --audio-format mp3 -o "${rawPath}" "${url}"`);

    // FFmpeg: Cut duration, Speed Adjustment, & Fix Volume -4dB
    const ffmpegCmd = `ffmpeg -i "${rawPath}" -t ${duration} -filter:a "atempo=${speed},volume=-4dB" "${outputPath}"`;
    await execPromise(ffmpegCmd);

    if (fs.existsSync(rawPath)) fs.unlinkSync(rawPath);

    res.json({
      fileUrl: `/downloads/processed_${id}.mp3`,
      fileName: `processed_${id}.mp3`
    });
  } catch (err) {
    res.status(500).json({ error: "Gagal memproses audio", details: err.message });
  }
});

// 4. Upload to Roblox via API Key
app.post("/api/upload-roblox", async (req, res) => {
  try {
    const { apiKey, creatorType, creatorId, title, fileName } = req.body;
    const filePath = path.join(__dirname, "downloads", fileName);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "File audio tidak ditemukan." });
    }

    // Truncate title untuk Roblox DisplayName (Max 45 Karakter agar tidak crash)
    let robloxDisplayName = (title || "Studio Audio").trim();
    if (robloxDisplayName.length > 45) {
      robloxDisplayName = robloxDisplayName.substring(0, 42) + "...";
    }

    const fileBuffer = fs.readFileSync(filePath);
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
    const part2Header = `--${boundary}\r\nContent-Disposition: form-data; name="fileContent"; filename="${fileName}"\r\nContent-Type: audio/mpeg\r\n\r\n`;
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

    // Polling Operation Status
    for (let i = 0; i < 35; i++) {
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server Audio Studio running on port ${PORT}`));
