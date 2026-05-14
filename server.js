"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const querystring = require("querystring");
const Busboy = require("busboy");
const Tesseract = require("tesseract.js");

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");
const QUESTION_MEDIA_DIR = path.join(DATA_DIR, "question-media");
const SESSION_COOKIE = "math_quiz_session";
const SESSION_SECRET = crypto.randomBytes(32).toString("hex");
const QUIZ_SIZE = 30;

const FILES = {
  questions: path.join(DATA_DIR, "questions.json"),
  users: path.join(DATA_DIR, "users.json"),
  attempts: path.join(DATA_DIR, "attempts.json"),
  settings: path.join(DATA_DIR, "settings.json"),
  visuals: path.join(DATA_DIR, "visuals.json"),
  questionMedia: path.join(DATA_DIR, "question-media.json")
};

fs.mkdirSync(QUESTION_MEDIA_DIR, { recursive: true });
if (!fs.existsSync(FILES.questionMedia)) {
  fs.writeFileSync(FILES.questionMedia, "{}\n", "utf8");
}

let questions = readJson(FILES.questions);
let users = readJson(FILES.users);
let attempts = readJson(FILES.attempts);
let settings = readJson(FILES.settings);
let visualLibrary = readJson(FILES.visuals);
let questionMediaLibrary = readJson(FILES.questionMedia);
const sessions = new Map();

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function persistUsers() {
  writeJson(FILES.users, users);
}

function persistQuestions() {
  writeJson(FILES.questions, questions);
}

function persistAttempts() {
  writeJson(FILES.attempts, attempts);
}

function persistSettings() {
  writeJson(FILES.settings, settings);
}

function persistVisuals() {
  writeJson(FILES.visuals, visualLibrary);
}

function persistQuestionMedia() {
  writeJson(FILES.questionMedia, questionMediaLibrary);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function cleanText(value) {
  return String(value)
    .replace(/\r\n/g, "\n")
    .replace(/\uFFFD/g, "");
}

function nl2br(value) {
  return escapeHtml(cleanText(value)).replace(/\n/g, "<br>");
}

function parseCookies(request) {
  const header = request.headers.cookie || "";
  const cookies = {};

  header.split(";").forEach((part) => {
    const trimmed = part.trim();
    if (!trimmed) {
      return;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      return;
    }

    const key = trimmed.slice(0, separatorIndex);
    const value = trimmed.slice(separatorIndex + 1);
    cookies[key] = decodeURIComponent(value);
  });

  return cookies;
}

function sign(value) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(value).digest("hex");
}

function createSessionId() {
  const id = crypto.randomBytes(24).toString("hex");
  return `${id}.${sign(id)}`;
}

function verifySessionId(rawValue) {
  if (!rawValue) {
    return null;
  }

  const [id, token] = rawValue.split(".");
  if (!id || !token) {
    return null;
  }

  return sign(id) === token ? id : null;
}

function getSession(request) {
  const cookies = parseCookies(request);
  const verifiedId = verifySessionId(cookies[SESSION_COOKIE]);
  if (!verifiedId) {
    return null;
  }

  const session = sessions.get(verifiedId);
  if (!session) {
    return null;
  }

  session.id = verifiedId;
  return session;
}

function setSessionCookie(response, sessionId) {
  response.setHeader("Set-Cookie", `${SESSION_COOKIE}=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Lax`);
}

function clearSessionCookie(response) {
  response.setHeader("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function parseBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";

    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1e6) {
        request.destroy();
        reject(new Error("Request body too large"));
      }
    });

    request.on("end", () => {
      resolve(querystring.parse(body));
    });

    request.on("error", reject);
  });
}

function sendHtml(response, html, statusCode = 200, headers = {}) {
  response.writeHead(statusCode, {
    "Content-Type": "text/html; charset=utf-8",
    ...headers
  });
  response.end(html);
}

function sendRedirect(response, location, headers = {}) {
  response.writeHead(302, { Location: location, ...headers });
  response.end();
}

function sendFile(response, filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const contentType =
    extension === ".css"
      ? "text/css; charset=utf-8"
      : extension === ".js"
        ? "application/javascript; charset=utf-8"
        : extension === ".jpg" || extension === ".jpeg"
          ? "image/jpeg"
          : extension === ".png"
            ? "image/png"
            : extension === ".gif"
              ? "image/gif"
              : extension === ".webp"
                ? "image/webp"
        : "application/octet-stream";

  fs.readFile(filePath, (error, content) => {
    if (error) {
      sendHtml(response, renderStandalonePage("Not found", `<div class="card panel"><p>File not found.</p></div>`), 404);
      return;
    }

    response.writeHead(200, { "Content-Type": contentType });
    response.end(content);
  });
}

function requireLogin(request, response) {
  const session = getSession(request);
  if (!session || !session.userId) {
    sendRedirect(response, "/login");
    return null;
  }

  const user = findUserById(session.userId);
  if (!user) {
    sessions.delete(session.id);
    clearSessionCookie(response);
    sendRedirect(response, "/login");
    return null;
  }

  session.user = user;
  return session;
}

function requireAdmin(session, response) {
  if (!session.user || session.user.role !== "admin") {
    sendHtml(response, renderPage("Forbidden", session, `<div class="card panel"><h1>Forbidden</h1><p>You do not have permission to open this page.</p></div>`, "forbidden"), 403);
    return false;
  }

  return true;
}

function setFlash(session, text, tone = "success") {
  session.flash = { text, tone };
}

function consumeFlash(session) {
  const flash = session.flash || null;
  delete session.flash;
  return flash;
}

function normalizeUser(user) {
  return {
    ...user,
    role: user.role || "student",
    displayName: user.displayName || user.username
  };
}

function findUserById(userId) {
  return users.find((user) => user.id === userId) || null;
}

function findUserByUsername(username) {
  return users.find((user) => user.username.toLowerCase() === username.toLowerCase()) || null;
}

function createId(prefix) {
  return `${prefix}-${crypto.randomBytes(5).toString("hex")}`;
}

function getNextQuestionId() {
  return questions.length ? Math.max(...questions.map((question) => question.id)) + 1 : 1;
}

function getQuestionMedia(questionId) {
  return questionMediaLibrary[String(questionId)] || null;
}

function removeQuestionMedia(questionId) {
  const key = String(questionId);
  const media = questionMediaLibrary[key];
  if (!media) {
    return;
  }

  delete questionMediaLibrary[key];

  const stillUsed = Object.values(questionMediaLibrary).some((entry) => entry && entry.filename === media.filename);
  if (!stillUsed) {
    const filePath = path.join(QUESTION_MEDIA_DIR, media.filename);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }
}

function cleanupDraftFiles(draft, reservedFilenames = new Set()) {
  if (!draft || !Array.isArray(draft.items)) {
    return;
  }

  const filenames = new Set(
    draft.items
      .map((item) => item?.sourceImage?.filename)
      .filter(Boolean)
  );

  filenames.forEach((filename) => {
    if (reservedFilenames.has(filename)) {
      return;
    }

    const stillReferenced = Object.values(questionMediaLibrary).some((entry) => entry && entry.filename === filename);
    if (stillReferenced) {
      return;
    }

    const filePath = path.join(QUESTION_MEDIA_DIR, filename);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  });
}

function pruneAttemptReview(attempt, questionId) {
  const review = attempt.review.filter((item) => item.questionId !== questionId);
  if (!review.length) {
    return null;
  }

  const nextReview = review.map((item, index) => ({
    ...item,
    index: index + 1
  }));

  return {
    ...attempt,
    review: nextReview,
    total: nextReview.length,
    score: nextReview.filter((item) => item.isCorrect).length
  };
}

function deleteQuestionAndRecords(questionId) {
  const numericQuestionId = Number(questionId);
  const question = findQuestionById(numericQuestionId);
  if (!question) {
    return { question: null, attemptsUpdated: 0, attemptsRemoved: 0 };
  }

  questions = questions.filter((item) => item.id !== numericQuestionId);

  let attemptsUpdated = 0;
  let attemptsRemoved = 0;
  attempts = attempts.flatMap((attempt) => {
    if (!attempt.review.some((item) => item.questionId === numericQuestionId)) {
      return [attempt];
    }

    const nextAttempt = pruneAttemptReview(attempt, numericQuestionId);
    if (!nextAttempt) {
      attemptsRemoved += 1;
      return [];
    }

    attemptsUpdated += 1;
    return [nextAttempt];
  });

  delete visualLibrary[String(numericQuestionId)];
  removeQuestionMedia(numericQuestionId);

  sessions.forEach((session) => {
    if (session.quiz && Array.isArray(session.quiz.questionIds)) {
      session.quiz.questionIds = session.quiz.questionIds.filter((id) => id !== numericQuestionId);
      delete session.quiz.answers[String(numericQuestionId)];
      if (!session.quiz.questionIds.length) {
        session.quiz = createQuizState();
      }
    }

    if (session.lastAttemptId && !attempts.some((attempt) => attempt.id === session.lastAttemptId)) {
      delete session.lastAttemptId;
    }
  });

  persistQuestions();
  persistAttempts();
  persistVisuals();
  persistQuestionMedia();

  return { question, attemptsUpdated, attemptsRemoved };
}

function shuffle(array) {
  const copy = array.slice();
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}

function createQuizState() {
  const availableQuestions = getAvailableQuestions();
  const selected = shuffle(availableQuestions).slice(0, Math.min(QUIZ_SIZE, availableQuestions.length));
  return {
    questionIds: selected.map((question) => question.id),
    answers: {},
    startedAt: new Date().toISOString(),
    submittedAt: null,
    score: null
  };
}

function getQuiz(session) {
  const shouldResetForSettings =
    session.quiz &&
    !session.quiz.submittedAt &&
    !getQuizSettings().includeVisualQuestions &&
    session.quiz.questionIds.some((questionId) => {
      const question = findQuestionById(questionId);
      return question && question.type === "visual";
    });

  if (!session.quiz || session.quiz.submittedAt) {
    session.quiz = createQuizState();
  } else if (shouldResetForSettings) {
    session.quiz = createQuizState();
    setFlash(session, "Quiz restarted because visual questions are currently disabled by admin settings.", "success");
  }

  return session.quiz;
}

function findQuestionById(questionId) {
  return questions.find((question) => question.id === Number(questionId)) || null;
}

function countAnswered(quiz) {
  return Object.values(quiz.answers).filter(Boolean).length;
}

function computeScore(quiz) {
  return quiz.questionIds.reduce((score, questionId) => {
    const question = findQuestionById(questionId);
    return question && quiz.answers[String(questionId)] === question.correctOptionId ? score + 1 : score;
  }, 0);
}

function saveAnswer(body, quiz) {
  const questionId = String(body.questionId || "");
  const optionId = body.optionId ? String(body.optionId) : "";

  if (!questionId) {
    return;
  }

  if (optionId) {
    quiz.answers[questionId] = optionId;
  } else {
    delete quiz.answers[questionId];
  }
}

function clampIndex(value, max) {
  if (Number.isNaN(value)) {
    return 0;
  }

  if (value < 0) {
    return 0;
  }

  if (value > max) {
    return max;
  }

  return value;
}

function formatDate(value) {
  return new Date(value).toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function getQuizSettings() {
  return {
    includeVisualQuestions: settings?.quiz?.includeVisualQuestions !== false
  };
}

function getAvailableQuestions() {
  const quizSettings = getQuizSettings();
  return quizSettings.includeVisualQuestions
    ? questions
    : questions.filter((question) => question.type !== "visual");
}

function getAttemptById(attemptId) {
  return attempts.find((attempt) => attempt.id === attemptId) || null;
}

function normalizeReturnTo(value, fallback = "/accounts") {
  const target = String(value || "").trim();
  return target.startsWith("/") ? target : fallback;
}

function parseMultipartForm(request) {
  return new Promise((resolve, reject) => {
    const busboy = Busboy({
      headers: request.headers,
      limits: {
        files: 12,
        fileSize: 12 * 1024 * 1024,
        fields: 2000
      }
    });
    const fields = {};
    const fileTasks = [];
    let settled = false;

    function fail(error) {
      if (!settled) {
        settled = true;
        reject(error);
      }
    }

    busboy.on("field", (name, value) => {
      if (fields[name] === undefined) {
        fields[name] = value;
      } else if (Array.isArray(fields[name])) {
        fields[name].push(value);
      } else {
        fields[name] = [fields[name], value];
      }
    });

    busboy.on("file", (fieldName, file, info) => {
      if (!info.filename) {
        file.resume();
        return;
      }

      const extension = (path.extname(info.filename) || ".jpg").toLowerCase();
      const filename = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}${extension}`;
      const filePath = path.join(QUESTION_MEDIA_DIR, filename);
      const output = fs.createWriteStream(filePath);
      let size = 0;

      const task = new Promise((resolveFile, rejectFile) => {
        file.on("data", (chunk) => {
          size += chunk.length;
        });

        file.on("limit", () => {
          rejectFile(new Error(`Uploaded file "${info.filename}" is too large.`));
        });

        file.on("error", rejectFile);
        output.on("error", rejectFile);
        output.on("finish", () => {
          resolveFile({
            fieldName,
            originalFilename: info.filename,
            filename,
            filePath,
            mimeType: info.mimeType || "application/octet-stream",
            size
          });
        });
      });

      file.pipe(output);
      fileTasks.push(task);
    });

    busboy.on("error", fail);
    busboy.on("finish", () => {
      Promise.all(fileTasks)
        .then((files) => {
          if (!settled) {
            settled = true;
            resolve({ fields, files });
          }
        })
        .catch(fail);
    });

    request.pipe(busboy);
  });
}

function normalizeOcrText(text) {
  return cleanText(text)
    .replace(/\r/g, "\n")
    .replace(/[“”]/g, "\"")
    .replace(/[‘’]/g, "'")
    .replace(/[—–]/g, "-")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function inferQuestionType(stem, options, rawText) {
  const sample = `${stem}\n${options.map((option) => option.text).join("\n")}\n${rawText}`.toLowerCase();
  const visualMarkers = [
    "mirror image",
    "water image",
    "answer figure",
    "question figure",
    "transparent sheet",
    "folding",
    "folded",
    "embedded",
    "joined",
    "exactly the same",
    "figure",
    "punches"
  ];

  return visualMarkers.some((marker) => sample.includes(marker)) ? "visual" : "text";
}

function splitOcrBlocks(text) {
  const lines = normalizeOcrText(text)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const blocks = [];
  let current = [];

  lines.forEach((line) => {
    if (/^\d{1,2}[.)]\s+/.test(line) && current.length) {
      blocks.push(current);
      current = [line];
      return;
    }

    current.push(line);
  });

  if (current.length) {
    blocks.push(current);
  }

  return blocks.length ? blocks : [lines];
}

function parseOcrQuestionBlock(lines, fallbackPage, sourceImage) {
  const answerHints = [];
  const filteredLines = [];

  lines.forEach((line) => {
    const exactAnswerMatch = line.match(/^\(?([1-4])\)?$/);
    const namedAnswerMatch = line.match(/^(?:ans|answer)\s*[:=-]?\s*([1-4])$/i);
    if (exactAnswerMatch) {
      answerHints.push(exactAnswerMatch[1]);
      return;
    }

    if (namedAnswerMatch) {
      answerHints.push(namedAnswerMatch[1]);
      return;
    }

    filteredLines.push(line);
  });

  const optionLines = [];
  const stemLines = [];

  filteredLines.forEach((line, index) => {
    const optionMatch = line.match(/^(?:\(?([1-4])\)|([1-4])[.)])\s*(.+)$/);
    if (optionMatch) {
      optionLines.push({
        id: optionMatch[1] || optionMatch[2],
        text: optionMatch[3].trim()
      });
      return;
    }

    if (!optionLines.length) {
      const firstLineMatch = index === 0 ? line.match(/^\d{1,2}[.)]\s*(.+)$/) : null;
      stemLines.push(firstLineMatch ? firstLineMatch[1].trim() : line);
    }
  });

  if (optionLines.length < 4 || !stemLines.join(" ").trim()) {
    return null;
  }

  const stem = stemLines.join(" ").replace(/\s{2,}/g, " ").trim();
  const options = optionLines
    .slice(0, 4)
    .map((option, index) => ({
      id: String(index + 1),
      text: option.text
    }));

  const rawText = filteredLines.join("\n");
  const correctOptionId = answerHints[0] || "1";
  const type = inferQuestionType(stem, options, rawText);

  return {
    page: fallbackPage,
    type,
    stem,
    figureDescription: "",
    options,
    correctOptionId,
    sourceImage,
    rawText
  };
}

async function buildOcrDraftsFromImages(files, fallbackPage) {
  const drafts = [];

  for (const file of files) {
    const result = await Tesseract.recognize(file.filePath, "eng");
    const rawText = normalizeOcrText(result.data.text || "");
    const blocks = splitOcrBlocks(rawText);
    const parsed = blocks
      .map((lines) => parseOcrQuestionBlock(lines, fallbackPage, {
        filename: file.filename,
        originalFilename: file.originalFilename
      }))
      .filter(Boolean);

    if (parsed.length) {
      drafts.push(...parsed);
      continue;
    }

    drafts.push({
      page: fallbackPage,
      type: "text",
      stem: "",
      figureDescription: "",
      options: [
        { id: "1", text: "" },
        { id: "2", text: "" },
        { id: "3", text: "" },
        { id: "4", text: "" }
      ],
      correctOptionId: "1",
      sourceImage: {
        filename: file.filename,
        originalFilename: file.originalFilename
      },
      rawText
    });
  }

  return drafts;
}

function canViewAttempt(session, attempt) {
  return Boolean(attempt) && (session.user.role === "admin" || attempt.userId === session.user.id);
}

function buildAttemptFromQuiz(session, quiz) {
  const review = quiz.questionIds.map((questionId, index) => {
    const question = findQuestionById(questionId);
    const selectedOptionId = quiz.answers[String(questionId)] || "";
    const correctOptionId = question.correctOptionId;
    return {
      index: index + 1,
      questionId,
      selectedOptionId,
      correctOptionId,
      isCorrect: selectedOptionId === correctOptionId
    };
  });

  return {
    id: createId("attempt"),
    userId: session.user.id,
    username: session.user.username,
    displayName: session.user.displayName,
    startedAt: quiz.startedAt,
    submittedAt: new Date().toISOString(),
    score: review.filter((item) => item.isCorrect).length,
    total: review.length,
    review
  };
}

function buildNotebookEntries(userId) {
  const notebookMap = new Map();

  attempts
    .filter((attempt) => attempt.userId === userId)
    .sort((left, right) => new Date(right.submittedAt) - new Date(left.submittedAt))
    .forEach((attempt) => {
      attempt.review.forEach((item) => {
        if (item.isCorrect) {
          return;
        }

        const question = findQuestionById(item.questionId);
        if (!question) {
          return;
        }

        const current = notebookMap.get(item.questionId) || {
          questionId: item.questionId,
          question,
          wrongCount: 0,
          lastWrongAt: attempt.submittedAt,
          lastSelectedOptionId: item.selectedOptionId,
          lastCorrectOptionId: item.correctOptionId
        };

        current.wrongCount += 1;
        if (new Date(attempt.submittedAt) >= new Date(current.lastWrongAt)) {
          current.lastWrongAt = attempt.submittedAt;
          current.lastSelectedOptionId = item.selectedOptionId;
          current.lastCorrectOptionId = item.correctOptionId;
        }

        notebookMap.set(item.questionId, current);
      });
    });

  return Array.from(notebookMap.values()).sort((left, right) => new Date(right.lastWrongAt) - new Date(left.lastWrongAt));
}

function renderFlash(session) {
  const flash = consumeFlash(session);
  if (!flash) {
    return "";
  }

  return `<div class="message ${escapeHtml(flash.tone)}">${escapeHtml(flash.text)}</div>`;
}

function renderNav(session, current) {
  const links = [
    { href: "/quiz", label: "Practice", key: "quiz" },
    { href: "/records", label: "Records", key: "records" },
    { href: "/notebook", label: "Wrong Notebook", key: "notebook" }
  ];

  if (session && session.user && session.user.role === "admin") {
    links.push({ href: "/accounts", label: "Students", key: "accounts" });
  }

  const linksHtml = links
    .map((link) => {
      const className = link.key === current ? "nav-link active" : "nav-link";
      return `<a class="${className}" href="${link.href}">${escapeHtml(link.label)}</a>`;
    })
    .join("");

  const userBlock = session && session.user
    ? `<div class="nav-user">
        <div>
          <strong>${escapeHtml(session.user.displayName)}</strong>
          <div class="small muted">${escapeHtml(session.user.role)}</div>
        </div>
        <form method="post" action="/logout">
          <button class="btn btn-danger btn-sm" type="submit">Logout</button>
        </form>
      </div>`
    : "";

  return `<header class="site-header card">
    <div class="brand-block">
      <div class="brand-mark">MQ</div>
      <div>
        <div class="brand-title">Math Quiz Studio</div>
        <div class="small muted">Local Node.js practice system with saved records</div>
      </div>
    </div>
    <nav class="site-nav">${linksHtml}</nav>
    ${userBlock}
  </header>`;
}

function renderStandalonePage(title, content) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <div class="shell">
    <div class="container">${content}</div>
  </div>
</body>
</html>`;
}

function renderPage(title, session, body, current) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <div class="shell">
    <div class="container">
      ${renderNav(session, current)}
      ${renderFlash(session)}
      ${body}
    </div>
  </div>
  <script src="/app.js"></script>
</body>
</html>`;
}

function renderLogin(message = "") {
  const messageBlock = message ? `<div class="message error">${escapeHtml(message)}</div>` : "";

  return renderStandalonePage(
    "Login",
    `<div class="login-wrap">
      <div class="card login-card">
        <section class="hero">
          <span class="eyebrow">Local Web Application</span>
          <h1>English Math Quiz Practice</h1>
          <p>The quiz runs fully on your computer. Students can log in, practice randomized questions, submit papers, review scores, and build a wrong-question notebook.</p>
          <ul>
            <li>SVG redrawn figure questions</li>
            <li>Saved quiz records in local JSON files</li>
            <li>Admin-managed student accounts</li>
          </ul>
        </section>
        <section class="login-panel">
          <span class="eyebrow">Sign In</span>
          <h2 class="panel-title">Login to start practicing</h2>
          <p class="muted">Admin: <strong>admin</strong> / <strong>admin1234</strong></p>
          <p class="muted">Student: <strong>student</strong> / <strong>math1234</strong></p>
          ${messageBlock}
          <form method="post" action="/login">
            <div class="field">
              <label for="username">Username</label>
              <input id="username" name="username" autocomplete="username" required>
            </div>
            <div class="field">
              <label for="password">Password</label>
              <input id="password" type="password" name="password" autocomplete="current-password" required>
            </div>
            <div class="btn-row" style="margin-top: 24px;">
              <button class="btn btn-primary" type="submit">Login</button>
            </div>
          </form>
        </section>
      </div>
    </div>`
  );
}

function getVisualSet(questionId) {
  return visualLibrary[String(questionId)] || null;
}

function renderQuestionFigure(question) {
  const visualSet = getVisualSet(question.id);
  const svg = visualSet && visualSet.question ? visualSet.question : "";
  const media = getQuestionMedia(question.id);
  const image = media
    ? `<div class="figure-image-wrap"><img class="question-image" src="/question-media/${encodeURIComponent(media.filename)}" alt="Question image ${question.id}"></div>`
    : "";
  const note = question.figureDescription ? `<div class="figure-note"><strong>Figure note:</strong> ${nl2br(question.figureDescription)}</div>` : "";

  if (!svg && !image && !note) {
    return "";
  }

  return `<div class="figure-panel">${svg}${image}${note}</div>`;
}

function summarizeStem(stem) {
  const compact = cleanText(stem).replace(/\s+/g, " ").trim();
  return compact.length > 120 ? `${compact.slice(0, 117)}...` : compact;
}

function renderOption(option, question, selectedId) {
  const checked = selectedId === option.id ? "checked" : "";
  const visualSet = getVisualSet(question.id);
  const optionSvg = visualSet && visualSet.options ? visualSet.options[option.id] : "";
  const optionClass = optionSvg ? "option visual-option" : "option";
  const figureBlock = optionSvg ? `<div class="option-figure">${optionSvg}</div>` : "";

  return `<label class="${optionClass}">
    <input type="radio" name="optionId" value="${escapeHtml(option.id)}" ${checked}>
    ${figureBlock}
    <div class="option-copy">
      <span class="option-id">${escapeHtml(option.id)}.</span>
      <span>${escapeHtml(cleanText(option.text))}</span>
    </div>
  </label>`;
}

function renderPreviewOption(option, question, selectedOptionId, correctOptionId) {
  const visualSet = getVisualSet(question.id);
  const optionSvg = visualSet && visualSet.options ? visualSet.options[option.id] : "";
  const classes = ["preview-option"];

  if (selectedOptionId === option.id) {
    classes.push("selected");
  }

  if (correctOptionId === option.id) {
    classes.push("correct");
  }

  return `<div class="${classes.join(" ")}">
    ${optionSvg ? `<div class="option-figure">${optionSvg}</div>` : ""}
    <div class="option-copy">
      <span class="option-id">${escapeHtml(option.id)}.</span>
      <span>${escapeHtml(cleanText(option.text))}</span>
    </div>
    <div class="preview-option-tags">
      ${selectedOptionId === option.id ? `<span class="pill">Your answer</span>` : ""}
      ${correctOptionId === option.id ? `<span class="pill correct">Correct</span>` : ""}
    </div>
  </div>`;
}

function renderQuestionPreviewModal(attempt, item, question) {
  const modalId = `question-preview-${attempt.id}-${item.questionId}`;
  const optionsHtml = question.options
    .map((option) => renderPreviewOption(option, question, item.selectedOptionId, item.correctOptionId))
    .join("");

  return `<div class="modal-backdrop" id="${escapeHtml(modalId)}" hidden>
    <div class="modal-card card" role="dialog" aria-modal="true" aria-labelledby="${escapeHtml(modalId)}-title">
      <div class="modal-head">
        <div>
          <span class="eyebrow">Original Question Preview</span>
          <h2 id="${escapeHtml(modalId)}-title" class="modal-title">Source Question ${question.id}</h2>
          <div class="question-meta">Page ${question.page} &middot; Type: ${escapeHtml(question.type)}</div>
        </div>
        <button class="btn btn-secondary btn-sm" type="button" data-modal-close>Close</button>
      </div>
      <div class="modal-body">
        <div class="question-box">
          <div class="question-text">${nl2br(question.stem)}</div>
          ${renderQuestionFigure(question)}
        </div>
        <div class="options-box" style="margin-top: 18px;">
          <h3 style="margin-top: 0;">Options</h3>
          <div class="preview-options-list">${optionsHtml}</div>
        </div>
      </div>
    </div>
  </div>`;
}

function renderQuizPage(session, index) {
  const quiz = getQuiz(session);
  const maxIndex = quiz.questionIds.length - 1;
  const safeIndex = clampIndex(index, maxIndex);
  const questionId = quiz.questionIds[safeIndex];
  const question = findQuestionById(questionId);
  const selectedOptionId = quiz.answers[String(questionId)] || "";
  const answeredCount = countAnswered(quiz);
  const unansweredCount = quiz.questionIds.length - answeredCount;
  const progress = `${safeIndex + 1} / ${quiz.questionIds.length}`;

  const optionHtml = question.options.map((option) => renderOption(option, question, selectedOptionId)).join("");
  const navButtons = quiz.questionIds
    .map((id, idx) => {
      const answer = quiz.answers[String(id)];
      const classes = ["nav-button"];
      if (idx === safeIndex) {
        classes.push("current");
      } else if (answer) {
        classes.push("answered");
      }

      return `<button class="${classes.join(" ")}" type="submit" name="jumpTo" value="${idx}" formaction="/quiz/navigation" formmethod="post">${idx + 1}</button>`;
    })
    .join("");

  const body = `<div class="topbar">
      <div>
        <h1>Practice Workspace</h1>
        <p class="muted">Question order is randomized from the JSON question bank for every new paper.</p>
      </div>
      <div class="toolbar">
        <form method="post" action="/quiz/restart">
          <button class="btn btn-secondary" type="submit">New Random Quiz</button>
        </form>
      </div>
    </div>

    <div class="quiz-layout">
      <section class="card panel">
        <span class="eyebrow">Question ${safeIndex + 1} of ${quiz.questionIds.length}</span>
        <h2 class="question-title">Source Question ${question.id}</h2>
        <div class="question-meta">Imported from Page ${question.page} &middot; Type: ${escapeHtml(question.type)}</div>

        <div class="stats">
          <div class="stat">
            <div class="muted small">Progress</div>
            <strong>${progress}</strong>
          </div>
          <div class="stat">
            <div class="muted small">Answered</div>
            <strong>${answeredCount}</strong>
          </div>
          <div class="stat">
            <div class="muted small">Unanswered</div>
            <strong>${unansweredCount}</strong>
          </div>
        </div>

        <form method="post" action="/quiz/navigation">
          <input type="hidden" name="questionId" value="${question.id}">
          <input type="hidden" name="currentIndex" value="${safeIndex}">
          <div class="question-grid">
            <div class="question-box">
              <div class="question-text">${nl2br(question.stem)}</div>
              ${renderQuestionFigure(question)}
            </div>
            <div class="options-box">
              <h3 style="margin-top: 0;">Options</h3>
              <div class="options-list">${optionHtml}</div>
            </div>
          </div>

          <div class="footer-actions">
            <button class="btn btn-secondary" type="submit" name="move" value="prev">Previous</button>
            <button class="btn btn-secondary" type="submit" name="move" value="next">Next</button>
            <button class="btn btn-primary" type="submit" name="move" value="stay">Save Answer</button>
            <button class="btn btn-danger" type="submit" formaction="/quiz/submit" formmethod="post" data-submit-quiz data-unanswered="${unansweredCount}">Confirm Submit</button>
          </div>

          <div class="nav-box">
            <h3 style="margin: 0;">Jump To Question</h3>
            <div class="legend">
              <span><i class="dot dot-current"></i>Current</span>
              <span><i class="dot dot-answered"></i>Answered</span>
              <span><i class="dot dot-empty"></i>Not answered</span>
            </div>
            <div class="nav-grid">${navButtons}</div>
          </div>
        </form>
      </section>

      <aside class="card panel summary-box">
        <span class="eyebrow">Quiz Tools</span>
        <h3>Practice Notes</h3>
        <p class="muted">SVG figure questions are redrawn to be closer to the original paper while keeping the layout clean for online practice.</p>
        <p class="muted">After submission, your score is saved to the local records file and mistakes are added to the wrong notebook.</p>
        <div class="mini-actions">
          <a class="btn btn-secondary" href="/records">View Records</a>
          <a class="btn btn-secondary" href="/notebook">Open Wrong Notebook</a>
        </div>
      </aside>
    </div>`;

  return renderPage("Quiz", session, body, "quiz");
}

function renderResultPage(session, attempt) {
  const percentage = Math.round((attempt.score / attempt.total) * 100);
  const adminReviewNote = session.user.role === "admin"
    ? `<p class="muted">Admin mode is active on this review page. You can delete a problematic source question below, and the system will also clean related saved records automatically.</p>`
    : `<p class="muted">This paper has been saved into the local records file.</p>`;

  const reviewItems = attempt.review
    .map((item) => {
      const question = findQuestionById(item.questionId);
      if (!question) {
        return "";
      }

      const stateClass = item.isCorrect ? "correct" : item.selectedOptionId ? "wrong" : "unanswered";
      const selectedText = item.selectedOptionId
        ? question.options.find((option) => option.id === item.selectedOptionId)?.text || item.selectedOptionId
        : "No answer";
      const correctText = question.options.find((option) => option.id === item.correctOptionId)?.text || item.correctOptionId;
      const modalId = `question-preview-${attempt.id}-${item.questionId}`;
      const adminDeleteAction = session.user.role === "admin"
        ? `<form method="post" action="/questions/delete">
            <input type="hidden" name="questionId" value="${question.id}">
            <input type="hidden" name="returnTo" value="/result?attempt=${encodeURIComponent(attempt.id)}">
            <button class="btn btn-danger btn-sm" type="submit" data-confirm="Delete Source Question ${question.id} and remove its history from saved attempts?">Delete Question</button>
          </form>`
        : "";

      return `<div class="review-item ${stateClass}">
          <div class="review-head">
            <strong>${item.index}. Source Question ${question.id}</strong>
            <span class="pill ${stateClass}">${item.isCorrect ? "Correct" : item.selectedOptionId ? "Wrong" : "Unanswered"}</span>
          </div>
          <div class="small muted">${escapeHtml(question.stem)}</div>
          ${renderQuestionFigure(question)}
          <div class="small"><strong>Your answer:</strong> ${escapeHtml(cleanText(selectedText))}</div>
          <div class="small"><strong>Correct answer:</strong> ${escapeHtml(cleanText(correctText))}</div>
          <div class="btn-row" style="margin-top: 12px;">
            <button class="btn btn-secondary btn-sm" type="button" data-modal-open="${escapeHtml(modalId)}">Preview Original Question</button>
          </div>
          ${adminDeleteAction}
          ${renderQuestionPreviewModal(attempt, item, question)}
        </div>`;
    })
    .join("");

  const body = `<div class="topbar">
      <div>
        <h1>Quiz Result</h1>
        <p class="muted">${escapeHtml(attempt.displayName)} &middot; Submitted ${escapeHtml(formatDate(attempt.submittedAt))}</p>
      </div>
      <div class="toolbar">
        <form method="post" action="/quiz/restart">
          <button class="btn btn-primary" type="submit">Try Another Random Quiz</button>
        </form>
      </div>
    </div>

    <div class="quiz-layout">
      <section class="card panel result-box">
        <span class="eyebrow">Score</span>
        <div class="result-score">
          <strong>${attempt.score}/${attempt.total}</strong>
          <div class="muted">${percentage}% correct</div>
        </div>
        ${adminReviewNote}
        <div class="review-list">${reviewItems}</div>
      </section>

      <aside class="card panel summary-box">
        <span class="eyebrow">Saved Attempt</span>
        <div class="stats">
          <div class="stat">
            <div class="muted small">Correct</div>
            <strong>${attempt.score}</strong>
          </div>
          <div class="stat">
            <div class="muted small">Wrong</div>
            <strong>${attempt.total - attempt.score}</strong>
          </div>
          <div class="stat">
            <div class="muted small">Time</div>
            <strong>${attempt.total}</strong>
          </div>
        </div>
        <div class="mini-actions" style="margin-top: 16px;">
          <a class="btn btn-secondary" href="/records">All Records</a>
          <a class="btn btn-secondary" href="/notebook">Wrong Notebook</a>
        </div>
      </aside>
    </div>`;

  return renderPage("Result", session, body, "records");
}

function renderRecordsPage(session) {
  const visibleAttempts = (session.user.role === "admin" ? attempts : attempts.filter((attempt) => attempt.userId === session.user.id))
    .slice()
    .sort((left, right) => new Date(right.submittedAt) - new Date(left.submittedAt));

  const content = visibleAttempts.length
    ? visibleAttempts
      .map((attempt) => {
        const percent = Math.round((attempt.score / attempt.total) * 100);
        const reviewLabel = session.user.role === "admin" ? "Review / Delete Questions" : "Review";
        return `<div class="record-card">
            <div>
              <strong>${escapeHtml(attempt.displayName)}</strong>
              <div class="small muted">${escapeHtml(formatDate(attempt.submittedAt))}</div>
            </div>
            <div class="record-stats">
              <span>${attempt.score}/${attempt.total}</span>
              <span>${percent}%</span>
            </div>
            <a class="btn btn-secondary btn-sm" href="/result?attempt=${encodeURIComponent(attempt.id)}">${reviewLabel}</a>
          </div>`;
      })
      .join("")
    : `<div class="empty-card">No saved records yet.</div>`;

  const body = `<div class="topbar">
      <div>
        <h1>Saved Records</h1>
        <p class="muted">${session.user.role === "admin" ? "All student attempts are shown here." : "Your submitted papers are saved locally."}</p>
      </div>
    </div>
    <section class="card panel">
      <span class="eyebrow">Attempt History</span>
      ${session.user.role === "admin" ? `<p class="muted">Admin only: open any saved paper to review answers and delete a problematic question directly from that record.</p>` : ""}
      <div class="record-list">${content}</div>
    </section>`;

  return renderPage("Records", session, body, "records");
}

function renderNotebookPage(session) {
  const entries = buildNotebookEntries(session.user.id);

  const content = entries.length
    ? entries
      .map((entry) => {
        const question = entry.question;
        const selectedText = entry.lastSelectedOptionId
          ? question.options.find((option) => option.id === entry.lastSelectedOptionId)?.text || entry.lastSelectedOptionId
          : "No answer";
        const correctText = question.options.find((option) => option.id === entry.lastCorrectOptionId)?.text || entry.lastCorrectOptionId;

        return `<div class="review-item wrong">
            <div class="review-head">
              <strong>Question ${question.id}</strong>
              <span class="pill wrong">${entry.wrongCount} time(s)</span>
            </div>
            <div class="small muted">Last missed ${escapeHtml(formatDate(entry.lastWrongAt))}</div>
            <div class="small muted" style="margin-top: 6px;">${escapeHtml(question.stem)}</div>
            ${renderQuestionFigure(question)}
            <div class="small"><strong>Last answer:</strong> ${escapeHtml(cleanText(selectedText))}</div>
            <div class="small"><strong>Correct answer:</strong> ${escapeHtml(cleanText(correctText))}</div>
          </div>`;
      })
      .join("")
    : `<div class="empty-card">No wrong questions yet. Great work.</div>`;

  const body = `<div class="topbar">
      <div>
        <h1>Wrong Notebook</h1>
        <p class="muted">Every submitted mistake is collected here for review.</p>
      </div>
    </div>
    <section class="card panel">
      <span class="eyebrow">Mistake Review</span>
      <div class="review-list">${content}</div>
    </section>`;

  return renderPage("Wrong Notebook", session, body, "notebook");
}

function renderImportDraftSection(session) {
  const draft = session.importDraft;
  if (!draft || !draft.items || !draft.items.length) {
    return "";
  }

  const cards = draft.items
    .map((item, index) => {
      const optionFields = item.options
        .map((option, optionIndex) => `<div>
            <label class="small muted">Option ${optionIndex + 1}</label>
            <input name="item_${index}_option_${optionIndex + 1}" value="${escapeHtml(option.text)}" required>
          </div>`)
        .join("");
      const imageBlock = item.sourceImage
        ? `<div class="import-image-wrap">
            <img class="question-image" src="/question-media/${encodeURIComponent(item.sourceImage.filename)}" alt="Imported source image ${index + 1}">
            <div class="small muted">${escapeHtml(item.sourceImage.originalFilename)}</div>
          </div>`
        : "";

      return `<article class="card panel import-card">
          <div class="review-head">
            <strong>Detected Question ${index + 1}</strong>
            <label class="small"><input type="checkbox" name="item_${index}_include" checked> Include</label>
          </div>
          ${imageBlock}
          <div class="account-grid">
            <div>
              <label>Page</label>
              <input name="item_${index}_page" value="${escapeHtml(item.page)}" required>
            </div>
            <div>
              <label>Type</label>
              <select name="item_${index}_type">
                <option value="text" ${item.type === "text" ? "selected" : ""}>text</option>
                <option value="visual" ${item.type === "visual" ? "selected" : ""}>visual</option>
              </select>
            </div>
            <div>
              <label>Correct option</label>
              <select name="item_${index}_correctOptionId">
                <option value="1" ${item.correctOptionId === "1" ? "selected" : ""}>1</option>
                <option value="2" ${item.correctOptionId === "2" ? "selected" : ""}>2</option>
                <option value="3" ${item.correctOptionId === "3" ? "selected" : ""}>3</option>
                <option value="4" ${item.correctOptionId === "4" ? "selected" : ""}>4</option>
              </select>
            </div>
            <div>
              <label class="small muted">Attach source image</label>
              <select name="item_${index}_attachImage">
                <option value="yes" ${item.sourceImage ? "selected" : ""}>yes</option>
                <option value="no" ${!item.sourceImage ? "selected" : ""}>no</option>
              </select>
            </div>
          </div>
          <div class="field">
            <label>Question stem</label>
            <textarea name="item_${index}_stem" rows="4" required>${escapeHtml(item.stem)}</textarea>
          </div>
          <div class="field">
            <label>Figure description</label>
            <textarea name="item_${index}_figureDescription" rows="3">${escapeHtml(item.figureDescription || "")}</textarea>
          </div>
          <div class="account-grid">${optionFields}</div>
          <div class="field">
            <label>OCR raw text</label>
            <textarea rows="6" readonly>${escapeHtml(item.rawText || "")}</textarea>
          </div>
          <input type="hidden" name="item_${index}_sourceImageFilename" value="${escapeHtml(item.sourceImage ? item.sourceImage.filename : "")}">
          <input type="hidden" name="item_${index}_sourceImageOriginalFilename" value="${escapeHtml(item.sourceImage ? item.sourceImage.originalFilename : "")}">
        </article>`;
    })
    .join("");

  return `<section class="card panel" style="margin-top: 18px;">
      <span class="eyebrow">OCR Review</span>
      <p class="muted">The system has extracted draft questions from the uploaded images. Please review the text and answers before saving them into the question bank.</p>
      <form method="post" action="/questions/import/commit">
        <input type="hidden" name="draftCount" value="${draft.items.length}">
        <div class="record-list">${cards}</div>
        <div class="btn-row" style="margin-top: 18px;">
          <button class="btn btn-primary" type="submit">Save Draft Questions</button>
          <button class="btn btn-secondary" type="submit" formaction="/questions/import/discard" formmethod="post">Discard Draft</button>
        </div>
      </form>
    </section>`;
}

function renderQuestionBankSection() {
  const typeCounts = questions.reduce((accumulator, question) => {
    accumulator[question.type] = (accumulator[question.type] || 0) + 1;
    return accumulator;
  }, {});

  const rows = questions
    .slice()
    .sort((left, right) => right.id - left.id)
    .map((question) => {
      const media = getQuestionMedia(question.id);
      return `<form class="account-row" method="post" action="/questions/delete">
          <input type="hidden" name="questionId" value="${question.id}">
          <input type="hidden" name="returnTo" value="/accounts">
          <div class="record-card" style="grid-template-columns: 88px 88px 1fr auto;">
            <div><strong>#${question.id}</strong><div class="small muted">Page ${escapeHtml(question.page)}</div></div>
            <div><span class="pill">${escapeHtml(question.type)}</span><div class="small muted">${media ? "image attached" : "no image"}</div></div>
            <div class="small muted">${escapeHtml(summarizeStem(question.stem))}</div>
            <button class="btn btn-danger btn-sm" type="submit" data-confirm="Delete Source Question ${question.id} and remove it from saved student records?">Delete</button>
          </div>
        </form>`;
    })
    .join("");

  return `<section class="card panel" style="margin-top: 18px;">
      <div class="topbar" style="margin-bottom: 0;">
        <div>
          <span class="eyebrow">Question Bank</span>
          <h2 style="margin: 10px 0 0;">Manage Imported Questions</h2>
          <p class="muted">Delete a question here to remove it from the bank and clean all student records that referenced it.</p>
        </div>
      </div>
      <div class="stats">
        <div class="stat"><div class="muted small">Total questions</div><strong>${questions.length}</strong></div>
        <div class="stat"><div class="muted small">Text questions</div><strong>${typeCounts.text || 0}</strong></div>
        <div class="stat"><div class="muted small">Visual questions</div><strong>${typeCounts.visual || 0}</strong></div>
      </div>
      <div class="account-list">${rows}</div>
    </section>`;
}

function renderAccountsPage(session) {
  const quizSettings = getQuizSettings();
  const students = users.slice().sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const rows = students
    .map((user) => {
      const canDelete = user.id !== session.user.id;
      return `<form class="account-row" method="post" action="/accounts/update">
          <input type="hidden" name="userId" value="${escapeHtml(user.id)}">
          <div class="account-grid">
            <div>
              <label class="small muted">Username</label>
              <input value="${escapeHtml(user.username)}" disabled>
            </div>
            <div>
              <label class="small muted">Display name</label>
              <input name="displayName" value="${escapeHtml(user.displayName)}" required>
            </div>
            <div>
              <label class="small muted">Password</label>
              <input name="password" value="${escapeHtml(user.password)}" required>
            </div>
            <div>
              <label class="small muted">Role</label>
              <select name="role">
                <option value="student" ${user.role === "student" ? "selected" : ""}>student</option>
                <option value="admin" ${user.role === "admin" ? "selected" : ""}>admin</option>
              </select>
            </div>
          </div>
          <div class="btn-row" style="margin-top: 12px;">
            <button class="btn btn-secondary btn-sm" type="submit">Save</button>
            ${canDelete
              ? `<button class="btn btn-danger btn-sm" type="submit" formaction="/accounts/delete" formmethod="post" data-confirm="Delete user ${escapeHtml(user.username)}?">Delete</button>`
              : `<span class="small muted">Current login account cannot be deleted here.</span>`}
          </div>
        </form>`;
    })
    .join("");

  const body = `<div class="topbar">
      <div>
        <h1>Student Account Management</h1>
        <p class="muted">Accounts are saved in <code>data/users.json</code>.</p>
      </div>
    </div>

    <div class="quiz-layout">
      <section class="card panel">
        <span class="eyebrow">Create Account</span>
        <form method="post" action="/accounts/create">
          <div class="account-grid">
            <div>
              <label>Username</label>
              <input name="username" required>
            </div>
            <div>
              <label>Display name</label>
              <input name="displayName" required>
            </div>
            <div>
              <label>Password</label>
              <input name="password" required>
            </div>
            <div>
              <label>Role</label>
              <select name="role">
                <option value="student">student</option>
                <option value="admin">admin</option>
              </select>
            </div>
          </div>
          <div class="btn-row" style="margin-top: 16px;">
            <button class="btn btn-primary" type="submit">Create User</button>
          </div>
        </form>
      </section>

      <section class="card panel">
        <span class="eyebrow">Quiz Settings</span>
        <form method="post" action="/settings/quiz">
          <label style="display: flex; gap: 10px; align-items: flex-start;">
            <input type="checkbox" name="includeVisualQuestions" ${quizSettings.includeVisualQuestions ? "checked" : ""}>
            <span>
              <strong>Include visual questions</strong><br>
              <span class="muted">When turned off, all questions with <code>type: "visual"</code> are excluded from new quizzes. Visual SVG content is loaded from <code>data/visuals.json</code>.</span>
            </span>
          </label>
          <div class="btn-row" style="margin-top: 16px;">
            <button class="btn btn-primary" type="submit">Save Quiz Settings</button>
          </div>
        </form>
      </section>

      <section class="card panel">
        <span class="eyebrow">Import Questions</span>
        <form method="post" action="/questions/import" enctype="multipart/form-data">
          <div class="account-grid">
            <div>
              <label>Question photos</label>
              <input type="file" name="questionImages" accept="image/*" multiple required>
            </div>
            <div>
              <label>Default page number</label>
              <input name="page" value="201">
            </div>
          </div>
          <p class="muted" style="margin-top: 14px;">Upload one or more clear photos. OCR will create editable draft questions, then you can review and save them into the question bank.</p>
          <div class="btn-row" style="margin-top: 16px;">
            <button class="btn btn-primary" type="submit">Upload and Recognize</button>
          </div>
        </form>
      </section>

      <aside class="card panel summary-box">
        <span class="eyebrow">Admin Notes</span>
        <p class="muted">Use this page to add students, reset passwords, rename accounts, or promote another admin.</p>
        <p class="muted">Existing quiz records stay in <code>data/attempts.json</code> even if an account is later removed.</p>
        <p class="muted">If visual questions are turned off, any in-progress quiz containing them will restart the next time that user opens the quiz page.</p>
      </aside>
    </div>

    <section class="card panel" style="margin-top: 18px;">
      <span class="eyebrow">Existing Users</span>
      <div class="account-list">${rows}</div>
    </section>

    ${renderImportDraftSection(session)}
    ${renderQuestionBankSection()}`;

  return renderPage("Accounts", session, body, "accounts");
}

function validateCredentials(username, password) {
  return /^[a-zA-Z0-9._-]{3,24}$/.test(username) && String(password).length >= 4;
}

function routeRequest(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const pathname = url.pathname;

  if (request.method === "GET" && pathname === "/styles.css") {
    sendFile(response, path.join(PUBLIC_DIR, "styles.css"));
    return;
  }

  if (request.method === "GET" && pathname === "/app.js") {
    sendFile(response, path.join(PUBLIC_DIR, "app.js"));
    return;
  }

  if (request.method === "GET" && pathname.startsWith("/question-media/")) {
    const session = requireLogin(request, response);
    if (!session) {
      return;
    }

    const filename = path.basename(decodeURIComponent(pathname.slice("/question-media/".length)));
    sendFile(response, path.join(QUESTION_MEDIA_DIR, filename));
    return;
  }

  if (request.method === "GET" && pathname === "/") {
    const session = getSession(request);
    sendRedirect(response, session && session.userId ? "/quiz" : "/login");
    return;
  }

  if (request.method === "GET" && pathname === "/login") {
    sendHtml(response, renderLogin());
    return;
  }

  if (request.method === "POST" && pathname === "/login") {
    parseBody(request)
      .then((body) => {
        const username = String(body.username || "").trim();
        const password = String(body.password || "");
        const user = users.find((item) => item.username === username && item.password === password);

        if (!user) {
          sendHtml(response, renderLogin("Incorrect username or password."), 401);
          return;
        }

        const sessionId = createSessionId();
        const rawId = sessionId.split(".")[0];
        sessions.set(rawId, {
          userId: user.id,
          createdAt: new Date().toISOString(),
          quiz: createQuizState()
        });
        setSessionCookie(response, sessionId);
        sendRedirect(response, "/quiz");
      })
      .catch(() => {
        sendHtml(response, renderLogin("Unable to process the login request."), 400);
      });
    return;
  }

  if (request.method === "POST" && pathname === "/logout") {
    const session = getSession(request);
    if (session && session.id) {
      sessions.delete(session.id);
    }
    clearSessionCookie(response);
    sendRedirect(response, "/login");
    return;
  }

  if (request.method === "GET" && pathname === "/quiz") {
    const session = requireLogin(request, response);
    if (!session) {
      return;
    }

    const quiz = getQuiz(session);
    if (quiz.submittedAt && session.lastAttemptId) {
      sendRedirect(response, `/result?attempt=${encodeURIComponent(session.lastAttemptId)}`);
      return;
    }

    const index = clampIndex(Number(url.searchParams.get("index") || "0"), quiz.questionIds.length - 1);
    sendHtml(response, renderQuizPage(session, index));
    return;
  }

  if (request.method === "POST" && pathname === "/quiz/navigation") {
    const session = requireLogin(request, response);
    if (!session) {
      return;
    }

    const quiz = getQuiz(session);
    parseBody(request)
      .then((body) => {
        saveAnswer(body, quiz);
        const currentIndex = clampIndex(Number(body.currentIndex || "0"), quiz.questionIds.length - 1);
        let targetIndex = currentIndex;

        if (body.jumpTo !== undefined) {
          targetIndex = clampIndex(Number(body.jumpTo), quiz.questionIds.length - 1);
        } else if (body.move === "prev") {
          targetIndex = clampIndex(currentIndex - 1, quiz.questionIds.length - 1);
        } else if (body.move === "next") {
          targetIndex = clampIndex(currentIndex + 1, quiz.questionIds.length - 1);
        }

        sendRedirect(response, `/quiz?index=${targetIndex}`);
      })
      .catch(() => {
        setFlash(session, "Unable to save the current answer.", "error");
        sendRedirect(response, "/quiz");
      });
    return;
  }

  if (request.method === "POST" && pathname === "/quiz/submit") {
    const session = requireLogin(request, response);
    if (!session) {
      return;
    }

    const quiz = getQuiz(session);
    parseBody(request)
      .then((body) => {
        saveAnswer(body, quiz);
        quiz.score = computeScore(quiz);
        quiz.submittedAt = new Date().toISOString();

        const attempt = buildAttemptFromQuiz(session, quiz);
        attempts.push(attempt);
        persistAttempts();

        session.lastAttemptId = attempt.id;
        setFlash(session, `Paper submitted. Score saved: ${attempt.score}/${attempt.total}.`, "success");
        sendRedirect(response, `/result?attempt=${encodeURIComponent(attempt.id)}`);
      })
      .catch(() => {
        setFlash(session, "Unable to submit the paper.", "error");
        sendRedirect(response, "/quiz");
      });
    return;
  }

  if (request.method === "POST" && pathname === "/quiz/restart") {
    const session = requireLogin(request, response);
    if (!session) {
      return;
    }

    session.quiz = createQuizState();
    setFlash(session, "A new randomized quiz has started.", "success");
    sendRedirect(response, "/quiz");
    return;
  }

  if (request.method === "GET" && pathname === "/result") {
    const session = requireLogin(request, response);
    if (!session) {
      return;
    }

    const attemptId = String(url.searchParams.get("attempt") || session.lastAttemptId || "");
    const attempt = getAttemptById(attemptId);

    if (!canViewAttempt(session, attempt)) {
      sendRedirect(response, "/records");
      return;
    }

    sendHtml(response, renderResultPage(session, attempt));
    return;
  }

  if (request.method === "GET" && pathname === "/records") {
    const session = requireLogin(request, response);
    if (!session) {
      return;
    }

    sendHtml(response, renderRecordsPage(session));
    return;
  }

  if (request.method === "GET" && pathname === "/notebook") {
    const session = requireLogin(request, response);
    if (!session) {
      return;
    }

    sendHtml(response, renderNotebookPage(session));
    return;
  }

  if (request.method === "GET" && pathname === "/accounts") {
    const session = requireLogin(request, response);
    if (!session || !requireAdmin(session, response)) {
      return;
    }

    sendHtml(response, renderAccountsPage(session));
    return;
  }

  if (request.method === "POST" && pathname === "/questions/import") {
    const session = requireLogin(request, response);
    if (!session || !requireAdmin(session, response)) {
      return;
    }

    parseMultipartForm(request)
      .then(async ({ fields, files }) => {
        if (!files.length) {
          setFlash(session, "Please upload at least one image.", "error");
          sendRedirect(response, "/accounts");
          return;
        }

        const fallbackPage = Number(String(fields.page || "0")) || 0;
        const items = await buildOcrDraftsFromImages(files, fallbackPage);
        session.importDraft = {
          createdAt: new Date().toISOString(),
          items
        };
        setFlash(session, `OCR completed. Review ${items.length} draft question(s) before saving.`, "success");
        sendRedirect(response, "/accounts");
      })
      .catch((error) => {
        setFlash(session, `Unable to process uploaded images: ${error.message}`, "error");
        sendRedirect(response, "/accounts");
      });
    return;
  }

  if (request.method === "POST" && pathname === "/questions/import/discard") {
    const session = requireLogin(request, response);
    if (!session || !requireAdmin(session, response)) {
      return;
    }

    cleanupDraftFiles(session.importDraft);
    delete session.importDraft;
    setFlash(session, "OCR draft discarded.", "success");
    sendRedirect(response, "/accounts");
    return;
  }

  if (request.method === "POST" && pathname === "/questions/import/commit") {
    const session = requireLogin(request, response);
    if (!session || !requireAdmin(session, response)) {
      return;
    }

    parseBody(request)
      .then((body) => {
        const draftCount = Number(body.draftCount || "0");
        if (!session.importDraft || !Array.isArray(session.importDraft.items) || !draftCount) {
          setFlash(session, "No OCR draft is waiting to be saved.", "error");
          sendRedirect(response, "/accounts");
          return;
        }

        const newQuestions = [];
        for (let index = 0; index < draftCount; index += 1) {
          if (body[`item_${index}_include`] !== "on") {
            continue;
          }

          const stem = String(body[`item_${index}_stem`] || "").trim();
          const options = [1, 2, 3, 4].map((optionId) => ({
            id: String(optionId),
            text: String(body[`item_${index}_option_${optionId}`] || "").trim()
          }));

          if (!stem || options.some((option) => !option.text)) {
            continue;
          }

          const id = getNextQuestionId() + newQuestions.length;
          const page = Number(String(body[`item_${index}_page`] || "0")) || 0;
          const type = body[`item_${index}_type`] === "visual" ? "visual" : "text";
          const correctOptionId = ["1", "2", "3", "4"].includes(String(body[`item_${index}_correctOptionId`] || ""))
            ? String(body[`item_${index}_correctOptionId`])
            : "1";
          const figureDescription = String(body[`item_${index}_figureDescription`] || "").trim();

          newQuestions.push({
            id,
            page,
            type,
            stem,
            ...(figureDescription ? { figureDescription } : {}),
            options,
            correctOptionId
          });

          if (body[`item_${index}_attachImage`] === "yes" && body[`item_${index}_sourceImageFilename`]) {
            questionMediaLibrary[String(id)] = {
              filename: String(body[`item_${index}_sourceImageFilename`]),
              originalFilename: String(body[`item_${index}_sourceImageOriginalFilename`] || ""),
              importedAt: new Date().toISOString()
            };
          }
        }

        if (!newQuestions.length) {
          setFlash(session, "No valid questions were selected for import.", "error");
          sendRedirect(response, "/accounts");
          return;
        }

        questions.push(...newQuestions);
        persistQuestions();
        persistQuestionMedia();
        cleanupDraftFiles(session.importDraft, new Set(Object.values(questionMediaLibrary).map((entry) => entry.filename)));
        delete session.importDraft;
        setFlash(session, `${newQuestions.length} question(s) added to the question bank.`, "success");
        sendRedirect(response, "/accounts");
      })
      .catch(() => {
        setFlash(session, "Unable to save OCR draft questions.", "error");
        sendRedirect(response, "/accounts");
      });
    return;
  }

  if (request.method === "POST" && pathname === "/questions/delete") {
    const session = requireLogin(request, response);
    if (!session || !requireAdmin(session, response)) {
      return;
    }

    parseBody(request)
      .then((body) => {
        const questionId = String(body.questionId || "");
        const returnTo = normalizeReturnTo(body.returnTo, "/accounts");
        const result = deleteQuestionAndRecords(questionId);

        if (!result.question) {
          setFlash(session, "Question not found.", "error");
          sendRedirect(response, returnTo);
          return;
        }

        setFlash(
          session,
          `Source Question ${result.question.id} deleted. Updated ${result.attemptsUpdated} attempt(s) and removed ${result.attemptsRemoved} empty attempt(s).`,
          "success"
        );
        sendRedirect(response, returnTo);
      })
      .catch(() => {
        setFlash(session, "Unable to delete the question.", "error");
        sendRedirect(response, "/accounts");
      });
    return;
  }

  if (request.method === "POST" && pathname === "/settings/quiz") {
    const session = requireLogin(request, response);
    if (!session || !requireAdmin(session, response)) {
      return;
    }

    parseBody(request)
      .then((body) => {
        settings = {
          ...settings,
          quiz: {
            ...(settings && settings.quiz ? settings.quiz : {}),
            includeVisualQuestions: body.includeVisualQuestions === "on"
          }
        };
        persistSettings();
        setFlash(session, "Quiz settings saved. The change applies to new quizzes immediately.", "success");
        sendRedirect(response, "/accounts");
      })
      .catch(() => {
        setFlash(session, "Unable to save quiz settings.", "error");
        sendRedirect(response, "/accounts");
      });
    return;
  }

  if (request.method === "POST" && pathname === "/accounts/create") {
    const session = requireLogin(request, response);
    if (!session || !requireAdmin(session, response)) {
      return;
    }

    parseBody(request)
      .then((body) => {
        const username = String(body.username || "").trim();
        const displayName = String(body.displayName || "").trim();
        const password = String(body.password || "");
        const role = body.role === "admin" ? "admin" : "student";

        if (!validateCredentials(username, password)) {
          setFlash(session, "Username must be 3-24 characters and password at least 4 characters.", "error");
          sendRedirect(response, "/accounts");
          return;
        }

        if (!displayName) {
          setFlash(session, "Display name is required.", "error");
          sendRedirect(response, "/accounts");
          return;
        }

        if (findUserByUsername(username)) {
          setFlash(session, `Username "${username}" already exists.`, "error");
          sendRedirect(response, "/accounts");
          return;
        }

        users.push(normalizeUser({
          id: createId("user"),
          username,
          password,
          displayName,
          role,
          createdAt: new Date().toISOString()
        }));
        persistUsers();
        setFlash(session, `User ${username} created successfully.`, "success");
        sendRedirect(response, "/accounts");
      })
      .catch(() => {
        setFlash(session, "Unable to create the user.", "error");
        sendRedirect(response, "/accounts");
      });
    return;
  }

  if (request.method === "POST" && pathname === "/accounts/update") {
    const session = requireLogin(request, response);
    if (!session || !requireAdmin(session, response)) {
      return;
    }

    parseBody(request)
      .then((body) => {
        const userId = String(body.userId || "");
        const user = findUserById(userId);

        if (!user) {
          setFlash(session, "User not found.", "error");
          sendRedirect(response, "/accounts");
          return;
        }

        const displayName = String(body.displayName || "").trim();
        const password = String(body.password || "");
        const role = body.role === "admin" ? "admin" : "student";

        if (!displayName || password.length < 4) {
          setFlash(session, "Display name is required and password must be at least 4 characters.", "error");
          sendRedirect(response, "/accounts");
          return;
        }

        user.displayName = displayName;
        user.password = password;
        user.role = role;
        persistUsers();
        setFlash(session, `User ${user.username} updated.`, "success");
        sendRedirect(response, "/accounts");
      })
      .catch(() => {
        setFlash(session, "Unable to update the user.", "error");
        sendRedirect(response, "/accounts");
      });
    return;
  }

  if (request.method === "POST" && pathname === "/accounts/delete") {
    const session = requireLogin(request, response);
    if (!session || !requireAdmin(session, response)) {
      return;
    }

    parseBody(request)
      .then((body) => {
        const userId = String(body.userId || "");
        if (userId === session.user.id) {
          setFlash(session, "You cannot delete the account that is currently logged in.", "error");
          sendRedirect(response, "/accounts");
          return;
        }

        const nextUsers = users.filter((user) => user.id !== userId);
        if (nextUsers.length === users.length) {
          setFlash(session, "User not found.", "error");
          sendRedirect(response, "/accounts");
          return;
        }

        users = nextUsers;
        persistUsers();
        setFlash(session, "User deleted.", "success");
        sendRedirect(response, "/accounts");
      })
      .catch(() => {
        setFlash(session, "Unable to delete the user.", "error");
        sendRedirect(response, "/accounts");
      });
    return;
  }

  sendHtml(response, renderStandalonePage("Not found", `<div class="card panel"><h1>404</h1><p>The page you requested was not found.</p></div>`), 404);
}

const server = http.createServer((request, response) => {
  try {
    routeRequest(request, response);
  } catch (error) {
    sendHtml(
      response,
      renderStandalonePage("Server error", `<div class="card panel"><h1>Server Error</h1><p>${escapeHtml(error.message)}</p></div>`),
      500
    );
  }
});

server.listen(PORT, () => {
  console.log(`Local math quiz app is running at http://localhost:${PORT}`);
});

