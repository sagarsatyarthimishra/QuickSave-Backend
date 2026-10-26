const express = require("express");
const cors = require("cors");
const { spawn } = require("child_process");
const { randomUUID } = require("crypto");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT = Number(process.env.PORT || 5000);
const PYTHON = process.env.PYTHON_COMMAND || "python";
const OUTPUT_DIR = path.join(__dirname, "downloads");

const MAX_JOBS = 2;
const JOB_RETENTION = 60 * 60 * 1000;
const MAX_DURATION = 3 * 60 * 60;
const DOWNLOAD_TIMEOUT = 30 * 60 * 1000;
const MAX_FILE_SIZE = "2G";

const QUALITIES = [240, 360, 480, 720, 1080, 1440, 2160];
const VIDEO_EXTENSIONS = new Set([".mp4", ".m4v", ".mov", ".webm"]);

fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const jobs = new Map();
const processes = new Map();

/* ---------------- URL validation ---------------- */

function identifyVideoUrl(value) {
  if (typeof value !== "string" || !value.trim()) {
    return { success: false, message: "Video URL is required." };
  }

  let url;

  try {
    url = new URL(value.trim());
  } catch {
    return { success: false, message: "Invalid video URL." };
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    return {
      success: false,
      message: "Only HTTP and HTTPS URLs are supported.",
    };
  }

  const host = url.hostname.toLowerCase();
  const domain = (name) => host === name || host.endsWith(`.${name}`);

  // Block local/private IPv4 and common local hostnames.
  const isPrivateIPv4 = (() => {
    const match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!match) return false;

    const octets = match.slice(1).map(Number);
    if (octets.some((n) => n < 0 || n > 255)) return true;

    const [a, b] = octets;

    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  })();

  const blockedHost =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    host === "[::1]" ||
    host === "0.0.0.0" ||
    host === "[::]" ||
    isPrivateIPv4;

  if (blockedHost) {
    return {
      success: false,
      message: "Local or private network URLs are not supported.",
    };
  }

  if (
    domain("facebook.com") ||
    domain("fb.com") ||
    domain("fb.watch")
  ) {
    return {
      success: false,
      platform: "Facebook",
      message: "Facebook downloads are temporarily disabled.",
    };
  }

  const directVideo = VIDEO_EXTENSIONS.has(
    path.extname(url.pathname).toLowerCase()
  );

  let platform = null;

  if (
    domain("youtube.com") ||
    host === "youtu.be" ||
    domain("youtube-nocookie.com")
  ) {
    platform = "YouTube";
  } else if (domain("instagram.com") || host === "instagr.am") {
    platform = "Instagram";
  } else if (directVideo) {
    platform = "Direct Video";
  }

  if (!platform) {
    return {
      success: false,
      message: "Unsupported video URL.",
    };
  }

  return {
    success: true,
    platform,
    directVideo,
    url: url.href,
  };
}

/* ---------------- Helpers ---------------- */

function getResolution(format) {
  const width = Number(format.width) || 0;
  const height = Number(format.height) || 0;

  if (width && height) return Math.min(width, height);
  return height || width;
}

function getQualityLabel(resolution) {
  for (const quality of [2160, 1440, 1080, 720, 480, 360, 240]) {
    if (resolution >= quality) return `${quality}p`;
  }

  return `${resolution}p`;
}

function buildQualityOptions(info) {
  const formats = (info.formats || [])
    .filter((format) => {
      return (
        getResolution(format) > 0 &&
        format.vcodec &&
        format.vcodec !== "none" &&
        ["mp4", "webm", "mov", "m4v"].includes(format.ext)
      );
    })
    .sort((a, b) => {
      const difference = getResolution(b) - getResolution(a);
      if (difference) return difference;

      const mp4Difference =
        Number(b.ext === "mp4") - Number(a.ext === "mp4");

      if (mp4Difference) return mp4Difference;

      return (Number(b.tbr) || 0) - (Number(a.tbr) || 0);
    });

  const selected = new Map();

  for (const format of formats) {
    const resolution = getResolution(format);

    if (!selected.has(resolution)) {
      selected.set(resolution, format);
    }
  }

  return [...selected.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([resolution, format]) => {
      const duration = Number(info.duration) || 0;

      const estimated =
        Number(format.tbr) > 0 && duration > 0
          ? Math.round((Number(format.tbr) * 1000 * duration) / 8)
          : null;

      const exact = format.filesize ?? null;
      const size = exact ?? format.filesize_approx ?? estimated;

      return {
        id: String(format.format_id),
        label: `${getQualityLabel(resolution)} - ${format.ext.toUpperCase()}`,
        resolution,
        width: Number(format.width) || null,
        height: Number(format.height) || null,
        ext: format.ext,
        sizeBytes: size,
        sizeType:
          exact != null
            ? "exact"
            : size != null
              ? "estimated"
              : "unknown",
        hasAudio: Boolean(format.acodec && format.acodec !== "none"),
      };
    });
}

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    progress: job.progress,
    title: job.title,
    platform: job.platform,
    quality: job.quality,
    fileName: job.fileName,
    message: job.message,
    error: job.error,
    createdAt: job.createdAt,
    completedAt: job.completedAt,
    downloadUrl:
      job.status === "completed"
        ? `/api/download/${job.id}/file`
        : null,
  };
}

function findVideoFiles(directory) {
  const found = [];

  if (!fs.existsSync(directory)) return found;

  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      found.push(...findVideoFiles(fullPath));
    } else if (
      VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) &&
      !entry.name.endsWith(".part")
    ) {
      try {
        if (fs.statSync(fullPath).size > 0) {
          found.push(fullPath);
        }
      } catch {
        // Ignore files removed during scanning.
      }
    }
  }

  return found;
}

function isInsideDirectory(directory, filePath) {
  const relative = path.relative(directory, filePath);

  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function removeDirectory(directory) {
  try {
    fs.rmSync(directory, { recursive: true, force: true });
  } catch (error) {
    console.error("Directory cleanup failed:", error.message);
  }
}

function removeJob(id) {
  const job = jobs.get(id);

  if (!job || processes.has(id)) return;

  if (job.jobDir) {
    removeDirectory(job.jobDir);
  }

  jobs.delete(id);
}

function failJob(job, message, error) {
  job.status = "failed";
  job.message = message;
  job.error = String(error || message).slice(-3000);
  job.completedAt = Date.now();
}

/* ---------------- Automatic cleanup ---------------- */

setInterval(() => {
  const now = Date.now();

  for (const [id, job] of jobs) {
    const age = now - (job.completedAt || job.createdAt);

    if (age > JOB_RETENTION && !processes.has(id)) {
      removeJob(id);
    }
  }
}, 60_000).unref();

/* ---------------- Health ---------------- */

app.get("/api/health", (_req, res) => {
  res.json({
    success: true,
    app: "QuickSave Backend",
    message: "Backend is running.",
    platforms: ["YouTube", "Instagram", "Direct Video"],
  });
});

/* ---------------- Validate URL ---------------- */

app.post("/api/validate-url", (req, res) => {
  const result = identifyVideoUrl(req.body?.url);

  if (!result.success) {
    return res.status(400).json(result);
  }

  return res.json({
    success: true,
    platform: result.platform,
    directVideo: result.directVideo,
    metadataAvailable: false,
    downloadReady: false,
    message: `${result.platform} URL recognized.`,
  });
});

/* ---------------- Video metadata ---------------- */

app.post("/api/video-info", (req, res) => {
  const result = identifyVideoUrl(req.body?.url);

  if (!result.success) {
    return res.status(400).json(result);
  }

  const args = [
    "-m",
    "yt_dlp",
    "--ignore-config",
    "--no-warnings",
    "--no-playlist",
    "--dump-single-json",
    result.url,
  ];

  let child;

  try {
    child = spawn(PYTHON, args, {
      cwd: __dirname,
      windowsHide: true,
      shell: false,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: `Could not start yt-dlp: ${error.message}`,
    });
  }

  let stdout = "";
  let stderr = "";
  let settled = false;

  const timeout = setTimeout(() => {
    if (settled) return;

    settled = true;
    child.kill();

    res.status(504).json({
      success: false,
      message: "Metadata request timed out. Please try again.",
    });
  }, 60_000);

  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();

    if (stdout.length > 20 * 1024 * 1024) {
      child.kill();
    }
  });

  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-100_000);
  });

  child.on("error", (error) => {
    clearTimeout(timeout);

    if (settled) return;
    settled = true;

    console.error("Metadata process error:", error.message);

    res.status(500).json({
      success: false,
      message: `Could not start yt-dlp: ${error.message}`,
    });
  });

  child.on("close", (code) => {
    clearTimeout(timeout);

    if (settled) return;
    settled = true;

    if (code !== 0) {
      console.error("Metadata error:", stderr.slice(-3000));

      return res.status(502).json({
        success: false,
        platform: result.platform,
        formats: [],
        metadataAvailable: false,
        downloadReady: false,
        message:
          "Could not retrieve video details. The video may be private or unavailable.",
      });
    }

    try {
      const info = JSON.parse(stdout);
      const formats = buildQualityOptions(info);

      return res.json({
        success: true,
        platform: result.platform,
        title: info.title || "Untitled video",
        duration: info.duration ?? null,
        formats,
        metadataAvailable: true,
        downloadReady: formats.length > 0,
        message: formats.length
          ? "Available video qualities retrieved."
          : "No supported video qualities found.",
      });
    } catch (error) {
      console.error("Metadata parse error:", error.message);

      return res.status(502).json({
        success: false,
        message: "Could not parse video metadata.",
      });
    }
  });
});

/* ---------------- Start download ---------------- */

app.post("/api/download", (req, res) => {
  const result = identifyVideoUrl(req.body?.url);

  if (!result.success) {
    return res.status(400).json(result);
  }

  const quality = Number(req.body?.quality ?? 720);

  if (!Number.isInteger(quality) || !QUALITIES.includes(quality)) {
    return res.status(400).json({
      success: false,
      message: "Choose a supported quality.",
    });
  }

  if (processes.size >= MAX_JOBS) {
    return res.status(429).json({
      success: false,
      message: "Two downloads are already running. Try again shortly.",
    });
  }

  const id = randomUUID();
  const jobDir = path.join(OUTPUT_DIR, id);

  try {
    fs.mkdirSync(jobDir, { recursive: true });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: `Could not create download folder: ${error.message}`,
    });
  }

  const job = {
    id,
    jobDir,
    status: "queued",
    progress: 0,
    title: null,
    platform: result.platform,
    quality,
    fileName: null,
    filePath: null,
    message: "Download queued.",
    error: null,
    createdAt: Date.now(),
    completedAt: null,
  };

  jobs.set(id, job);

  // Use the real title and video ID in the saved filename.
  const outputTemplate = path.join(
    jobDir,
    "%(title).180B [%(id)s].%(ext)s"
  );

  const formatSelector = result.directVideo
    ? "bestvideo*+bestaudio/best"
    : `bv*[height<=${quality}]+ba/b[height<=${quality}]/bv*[width<=${quality}]+ba/b`;

  // Intentionally no --match-filter duration check:
  // Instagram can omit duration metadata for some posts.
  const args = [
    "-m",
    "yt_dlp",
    "--ignore-config",
    "--no-warnings",
    "--no-playlist",
    "--newline",
    "--max-filesize",
    MAX_FILE_SIZE,
    "-f",
    formatSelector,
    "--merge-output-format",
    "mp4",
    "--output",
    outputTemplate,
    "--print",
    "after_move:QS_FILE:%(filepath)s",
    "--progress-template",
    "download:QS_PROGRESS:%(progress._percent_str)s",
    result.url,
  ];

  let child;

  try {
    child = spawn(PYTHON, args, {
      cwd: __dirname,
      windowsHide: true,
      shell: false,
    });
  } catch (error) {
    failJob(job, "Could not start the downloader.", error.message);
    return res.status(500).json({
      success: false,
      message: job.message,
      error: job.error,
    });
  }

  processes.set(id, child);
  job.status = "downloading";
  job.message = "Starting download...";

  let stdoutBuffer = "";
  let stderrBuffer = "";
  let stderr = "";
  let finished = false;

  const timeout = setTimeout(() => {
    if (finished) return;

    job.message = "Download timed out.";
    job.error = "The download exceeded the 30-minute time limit.";

    try {
      child.kill();
    } catch {
      // Process may already have exited.
    }
  }, DOWNLOAD_TIMEOUT);

  function handleLine(rawLine) {
    const line = rawLine.trim();

    if (!line) return;

    if (line.includes("QS_PROGRESS:")) {
      const value = parseFloat(
        line.split("QS_PROGRESS:").pop().replace("%", "").trim()
      );

      if (Number.isFinite(value)) {
        job.progress = Math.max(0, Math.min(99, value));
        job.message = "Downloading video...";
      }
    }

    if (line.includes("QS_FILE:")) {
      const fileValue = line.split("QS_FILE:").pop().trim();
      const candidate = path.resolve(fileValue);

      if (isInsideDirectory(jobDir, candidate)) {
        job.filePath = candidate;
      }
    }

    if (
      line.includes("Merging formats") ||
      line.includes("Merger") ||
      line.includes("Merging audio")
    ) {
      job.message = "Merging audio and video...";
    }

    if (line.includes("[download] Destination:")) {
      job.message = "Downloading video...";
    }
  }

  function processOutput(buffer, chunk) {
    const combined = buffer + chunk.toString();
    const lines = combined.split(/\r?\n/);

    for (const line of lines.slice(0, -1)) {
      handleLine(line);
    }

    return lines[lines.length - 1] || "";
  }

  child.stdout.on("data", (chunk) => {
    stdoutBuffer = processOutput(stdoutBuffer, chunk);
  });

  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-100_000);
    stderrBuffer = processOutput(stderrBuffer, chunk);
  });

  child.on("error", (error) => {
    if (finished) return;

    finished = true;
    clearTimeout(timeout);
    processes.delete(id);

    failJob(job, "Could not start yt-dlp. Check Python installation.", error.message);

    console.error("Download process error:", error.message);
  });

  child.on("close", (code) => {
    if (finished) return;

    finished = true;
    clearTimeout(timeout);

    handleLine(stdoutBuffer);
    handleLine(stderrBuffer);

    processes.delete(id);

    // Always search this job's folder after yt-dlp exits.
    if (code === 0) {
      try {
        const files = findVideoFiles(jobDir);

        files.sort((a, b) => {
          return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs;
        });

        if (!job.filePath || !fs.existsSync(job.filePath)) {
          job.filePath = files[0] || null;
        }
      } catch (error) {
        job.filePath = null;
        console.error("File detection error:", error.message);
      }
    }

    if (
      code === 0 &&
      job.filePath &&
      fs.existsSync(job.filePath) &&
      isInsideDirectory(jobDir, job.filePath)
    ) {
      job.status = "completed";
      job.progress = 100;
      job.fileName = path.basename(job.filePath);
      job.title = path.basename(job.filePath, path.extname(job.filePath));
      job.message = "Download completed.";
      job.error = null;
      job.completedAt = Date.now();

      console.log("Download completed:", job.fileName);
    } else {
      job.status = "failed";
      job.message =
        job.message === "Download timed out."
          ? "Download timed out."
          : "Download failed.";

      if (!job.error) {
        job.error =
          stderr.slice(-3000) ||
          `yt-dlp exited with code ${code}; output file was not detected.`;
      }

      job.completedAt = Date.now();

      console.error(`Download ${id} failed:`, job.error);
    }
  });

  return res.status(202).json({
    success: true,
    job: publicJob(job),
    message: "Download job started.",
  });
});

/* ---------------- Get download status ---------------- */

app.get("/api/download/:id", (req, res) => {
  const job = jobs.get(req.params.id);

  if (!job) {
    return res.status(404).json({
      success: false,
      message: "Download job not found or expired.",
    });
  }

  return res.json({
    success: true,
    job: publicJob(job),
  });
});

/* ---------------- Download saved file ---------------- */

app.get("/api/download/:id/file", (req, res) => {
  const job = jobs.get(req.params.id);

  if (!job) {
    return res.status(404).json({
      success: false,
      message: "Download job not found or expired.",
    });
  }

  if (job.status !== "completed" || !job.filePath) {
    return res.status(409).json({
      success: false,
      message: "The video is not ready yet.",
      status: job.status,
    });
  }

  const filePath = path.resolve(job.filePath);

  if (!isInsideDirectory(job.jobDir, filePath) || !fs.existsSync(filePath)) {
    return res.status(404).json({
      success: false,
      message: "Downloaded file not found.",
    });
  }

  return res.download(filePath, job.fileName, (error) => {
    if (error && !res.headersSent) {
      console.error("File response error:", error.message);
      res.status(500).json({
        success: false,
        message: "Could not send the downloaded file.",
      });
    }
  });
});

/* ---------------- Cancel download ---------------- */

app.delete("/api/download/:id", (req, res) => {
  const job = jobs.get(req.params.id);

  if (!job) {
    return res.status(404).json({
      success: false,
      message: "Download job not found or expired.",
    });
  }

  const child = processes.get(job.id);

  if (child) {
    job.status = "failed";
    job.message = "Download cancelled.";
    job.error = "Cancelled by user.";
    job.completedAt = Date.now();

    child.kill();

    return res.json({
      success: true,
      message: "Download cancellation requested.",
      job: publicJob(job),
    });
  }

  removeJob(job.id);

  return res.json({
    success: true,
    message: "Download job removed.",
  });
});

/* ---------------- 404 and errors ---------------- */

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "API endpoint not found.",
  });
});

app.use((error, req, res, next) => {
  console.error("Server error:", error.message);

  if (res.headersSent) {
    return next(error);
  }

  return res.status(500).json({
    success: false,
    message: "Internal server error.",
  });
});

/* ---------------- Start server ---------------- */

app.listen(PORT, "0.0.0.0", () => {
  console.log(`QuickSave Backend running on port ${PORT}`);
  console.log(`Downloads directory: ${OUTPUT_DIR}`);
  console.log(`Python command: ${PYTHON}`);
});
