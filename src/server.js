import axios from "axios";
import cors from "cors";
import express from "express";
import { v4 as uuidv4 } from "uuid";
import { ClassevivaClient } from "./classevivaClient.js";
import { config } from "./config.js";
import { flattenNotesGroups, toStudentId, withDefaultRange } from "./utils.js";

const app = express();
const sessions = new Map();

app.use(cors());
app.use(express.json());

const postToGetPatterns = [
  /^\/api\/session$/,
  /^\/api\/card$/,
  /^\/api\/grades$/,
  /^\/api\/grades\/average$/,
  /^\/api\/lessons$/,
  /^\/api\/absences$/,
  /^\/api\/agenda$/,
  /^\/api\/notes$/,
  /^\/api\/subjects$/,
  /^\/api\/periods$/,
  /^\/api\/noticeboard$/,
  /^\/api\/calendar$/,
  /^\/api\/didactics$/,
  /^\/api\/documents$/,
  /^\/api\/documents\/status\/[^/]+$/,
  /^\/api\/documents\/read\/[^/]+$/,
  /^\/api\/documents\/download\/[^/]+$/,
  /^\/api\/overview$/
];

const shouldTreatPostAsGet = (path) => postToGetPatterns.some((pattern) => pattern.test(path));

app.use((req, res, next) => {
  if (req.method === "POST" && shouldTreatPostAsGet(req.path)) {
    req.method = "GET";
  }

  next();
});

app.use((req, res, next) => {
  const originalJson = res.json.bind(res);

  res.json = (payload) => {
    if (!req.localSessionId) {
      return originalJson(payload);
    }

    if (
      payload &&
      typeof payload === "object" &&
      !Array.isArray(payload) &&
      !Buffer.isBuffer(payload)
    ) {
      if (payload.sessionId !== undefined) {
        return originalJson(payload);
      }

      return originalJson({
        sessionId: req.localSessionId,
        ...payload
      });
    }

    return originalJson({
      sessionId: req.localSessionId,
      data: payload
    });
  };

  next();
});

const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

const normalizePath = (path) => {
  if (!path || typeof path !== "string") {
    return null;
  }

  const normalized = path.startsWith("/") ? path : `/${path}`;
  return normalized.startsWith("/v1/") ? normalized : null;
};

const toErrorObject = (error) => {
  if (axios.isAxiosError(error)) {
    return {
      message: error.message,
      status: error.response?.status || 502,
      remote: error.response?.data || null
    };
  }

  if (error && typeof error === "object" && "status" in error) {
    return {
      message: error.message || "Unexpected error",
      status: error.status || 500,
      remote: error.remote || null
    };
  }

  return {
    message: error?.message || "Unexpected error",
    status: 500,
    remote: null
  };
};

const buildGradesSummary = (grades) => {
  const numeric = grades.filter(
    (grade) => typeof grade.decimalValue === "number" && grade.canceled !== true
  );

  const average =
    numeric.length > 0
      ? Number(
          (
            numeric.reduce((total, current) => total + current.decimalValue, 0) /
            numeric.length
          ).toFixed(2)
        )
      : null;

  return {
    total: grades.length,
    validForAverage: numeric.length,
    average
  };
};

const buildGradesAverages = (grades) => {
  const validGrades = grades.filter(
    (grade) =>
      typeof grade.decimalValue === "number" &&
      Number.isFinite(grade.decimalValue) &&
      grade.canceled !== true
  );

  const computeAverage = (sum, count) => (count > 0 ? Number((sum / count).toFixed(2)) : null);

  const totalSum = validGrades.reduce((acc, grade) => acc + grade.decimalValue, 0);

  const periodMap = new Map();
  const subjectMap = new Map();

  for (const grade of validGrades) {
    const periodPos = Number.isFinite(grade.periodPos) ? grade.periodPos : null;
    const periodDesc =
      typeof grade.periodDesc === "string" && grade.periodDesc.trim()
        ? grade.periodDesc.trim()
        : "Senza periodo";
    const periodKey = `${periodPos ?? "none"}|${periodDesc}`;

    const periodEntry = periodMap.get(periodKey) || {
      periodPos,
      periodDesc,
      sum: 0,
      count: 0
    };
    periodEntry.sum += grade.decimalValue;
    periodEntry.count += 1;
    periodMap.set(periodKey, periodEntry);

    const subjectId = Number.isFinite(grade.subjectId) ? grade.subjectId : null;
    const subjectDesc =
      typeof grade.subjectDesc === "string" && grade.subjectDesc.trim()
        ? grade.subjectDesc.trim()
        : "Materia sconosciuta";
    const subjectKey = `${subjectId ?? "none"}|${subjectDesc}`;

    const subjectEntry = subjectMap.get(subjectKey) || {
      subjectId,
      subjectDesc,
      sum: 0,
      count: 0
    };
    subjectEntry.sum += grade.decimalValue;
    subjectEntry.count += 1;
    subjectMap.set(subjectKey, subjectEntry);
  }

  const byPeriod = [...periodMap.values()]
    .map((entry) => ({
      periodPos: entry.periodPos,
      periodDesc: entry.periodDesc,
      count: entry.count,
      average: computeAverage(entry.sum, entry.count)
    }))
    .sort((a, b) => {
      const aPos = a.periodPos ?? Number.MAX_SAFE_INTEGER;
      const bPos = b.periodPos ?? Number.MAX_SAFE_INTEGER;
      if (aPos !== bPos) {
        return aPos - bPos;
      }

      return a.periodDesc.localeCompare(b.periodDesc);
    });

  const bySubject = [...subjectMap.values()]
    .map((entry) => ({
      subjectId: entry.subjectId,
      subjectDesc: entry.subjectDesc,
      count: entry.count,
      average: computeAverage(entry.sum, entry.count)
    }))
    .sort((a, b) => a.subjectDesc.localeCompare(b.subjectDesc));

  return {
    total: {
      count: validGrades.length,
      average: computeAverage(totalSum, validGrades.length)
    },
    byPeriod,
    bySubject
  };
};

const findFirstNonEmpty = (...values) => {
  for (const value of values) {
    if (value === undefined || value === null) {
      continue;
    }

    const text = String(value).trim();
    if (text) {
      return text;
    }
  }

  return null;
};

const sanitizeAttachmentFileName = (value, fallback = "document.pdf") => {
  const fileName = findFirstNonEmpty(value, fallback) || fallback;
  return fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
};

const extractCredentials = (req) => {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const query = req.query && typeof req.query === "object" ? req.query : {};

  const uid = findFirstNonEmpty(
    body.uid,
    body.username,
    body.user,
    query.uid,
    query.username,
    query.user,
    req.header("x-uid"),
    req.header("x-username")
  );

  const password = findFirstNonEmpty(
    body.password,
    body.pass,
    query.password,
    query.pass,
    req.header("x-password"),
    req.header("x-pass")
  );

  if (!uid || !password) {
    return null;
  }

  return {
    uid,
    password,
    ident: findFirstNonEmpty(body.ident, query.ident, req.header("x-ident")) || null
  };
};

const createSession = async ({ uid, password, ident = null }) => {
  const client = new ClassevivaClient();
  const loginData = await client.login({ uid, password, ident });

  if (!loginData?.token) {
    const tokenError = new Error("ClasseViva login succeeded without token");
    tokenError.status = 502;
    tokenError.remote = loginData;
    throw tokenError;
  }

  const studentId = toStudentId(loginData.ident) || toStudentId(uid);
  if (!studentId) {
    const studentIdError = new Error("Could not infer studentId from ident/uid");
    studentIdError.status = 422;
    studentIdError.remote = {
      uid,
      ident: loginData.ident || null
    };
    throw studentIdError;
  }

  const sessionId = uuidv4();
  const session = {
    token: loginData.token,
    uid,
    ident: loginData.ident || null,
    studentId,
    firstName: loginData.firstName || null,
    lastName: loginData.lastName || null,
    release: loginData.release || null,
    expire: loginData.expire || null,
    createdAt: new Date().toISOString()
  };

  sessions.set(sessionId, session);

  return {
    sessionId,
    session,
    loginData
  };
};

const requireSession = async (req, res, next) => {
  try {
    const sessionId = req.header("x-session-id");
    const existingSession = sessionId ? sessions.get(sessionId) : null;

    if (existingSession) {
      req.localSessionId = sessionId;
      req.localSession = existingSession;
      res.setHeader("x-session-id", sessionId);
      return next();
    }

    const credentials = extractCredentials(req);
    if (credentials) {
      const created = await createSession(credentials);
      req.localSessionId = created.sessionId;
      req.localSession = created.session;
      req.autoLogin = true;
      res.setHeader("x-session-id", created.sessionId);
      return next();
    }

    if (sessionId) {
      return res.status(401).json({
        error: "Invalid or expired session",
        hint: "Use a valid x-session-id or send username/password (or uid/password) in body/query"
      });
    }

    return res.status(401).json({
      error: "Missing session",
      hint: "Use x-session-id or send username/password (or uid/password) in body/query"
    });
  } catch (error) {
    return next(error);
  }
};

const getClient = (session) => new ClassevivaClient(session.token);

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "cvv-api",
    sessions: sessions.size,
    baseUrl: config.classevivaBaseUrl
  });
});

app.post(
  "/api/login",
  asyncHandler(async (req, res) => {
    const credentials = extractCredentials(req);
    if (!credentials) {
      return res.status(400).json({
        error: "username/password or uid/password are required"
      });
    }

    const created = await createSession(credentials);
    req.localSessionId = created.sessionId;
    req.localSession = created.session;
    res.setHeader("x-session-id", created.sessionId);

    return res.json({
      sessionId: created.sessionId,
      studentId: created.session.studentId,
      profile: {
        uid: created.session.uid,
        ident: created.session.ident,
        firstName: created.session.firstName,
        lastName: created.session.lastName
      },
      token: {
        release: created.loginData.release || null,
        expire: created.loginData.expire || null
      }
    });
  })
);

app.post(
  "/api/logout",
  requireSession,
  asyncHandler(async (req, res) => {
    sessions.delete(req.localSessionId);
    res.json({ ok: true });
  })
);

app.get(
  "/api/session",
  requireSession,
  asyncHandler(async (req, res) => {
    const client = getClient(req.localSession);
    const status = await client.authStatus();

    res.json({
      localSessionId: req.localSessionId,
      localSession: {
        studentId: req.localSession.studentId,
        ident: req.localSession.ident,
        firstName: req.localSession.firstName,
        lastName: req.localSession.lastName,
        createdAt: req.localSession.createdAt
      },
      remote: status
    });
  })
);

app.get(
  "/api/card",
  requireSession,
  asyncHandler(async (req, res) => {
    const client = getClient(req.localSession);
    const data = await client.studentCard(req.localSession.studentId);
    res.json(data);
  })
);

app.get(
  "/api/grades",
  requireSession,
  asyncHandler(async (req, res) => {
    const client = getClient(req.localSession);
    const data = await client.grades(req.localSession.studentId);
    const grades = data.grades || [];

    res.json({
      summary: buildGradesSummary(grades),
      grades
    });
  })
);

app.get(
  "/api/grades/average",
  requireSession,
  asyncHandler(async (req, res) => {
    const client = getClient(req.localSession);
    const data = await client.grades(req.localSession.studentId);
    const grades = data.grades || [];

    res.json(buildGradesAverages(grades));
  })
);

app.get(
  "/api/lessons",
  requireSession,
  asyncHandler(async (req, res) => {
    const { day, start, end } = req.query;
    const client = getClient(req.localSession);

    let data;
    if (start && end) {
      data = await client.lessonsByRange(req.localSession.studentId, start, end);
    } else if (day) {
      data = await client.lessonsByDay(req.localSession.studentId, day);
    } else {
      data = await client.lessonsToday(req.localSession.studentId);
    }

    res.json({
      count: (data.lessons || []).length,
      lessons: data.lessons || []
    });
  })
);

app.get(
  "/api/absences",
  requireSession,
  asyncHandler(async (req, res) => {
    const { begin, end } = req.query;
    const client = getClient(req.localSession);

    let data;
    if (begin && end) {
      data = await client.absencesRange(req.localSession.studentId, begin, end);
    } else if (begin) {
      data = await client.absencesFrom(req.localSession.studentId, begin);
    } else {
      data = await client.absences(req.localSession.studentId);
    }

    res.json({
      count: (data.events || []).length,
      events: data.events || []
    });
  })
);

app.get(
  "/api/agenda",
  requireSession,
  asyncHandler(async (req, res) => {
    const { eventCode } = req.query;
    const range = withDefaultRange(req.query.begin, req.query.end);

    const client = getClient(req.localSession);
    const data = eventCode
      ? await client.agendaByEventCode(
          req.localSession.studentId,
          eventCode,
          range.begin,
          range.end
        )
      : await client.agenda(req.localSession.studentId, range.begin, range.end);

    res.json({
      begin: range.begin,
      end: range.end,
      eventCode: eventCode || "all",
      count: (data.agenda || []).length,
      agenda: data.agenda || []
    });
  })
);

app.get(
  "/api/notes",
  requireSession,
  asyncHandler(async (req, res) => {
    const client = getClient(req.localSession);
    const grouped = await client.notes(req.localSession.studentId);
    const flat = flattenNotesGroups(grouped);

    res.json({
      total: flat.length,
      grouped,
      notes: flat
    });
  })
);

app.post(
  "/api/notes/read",
  requireSession,
  asyncHandler(async (req, res) => {
    const { type, noteId } = req.body || {};

    if (!type || !noteId) {
      return res.status(400).json({
        error: "type and noteId are required"
      });
    }

    const client = getClient(req.localSession);
    const result = await client.readNote(req.localSession.studentId, type, noteId);
    res.json(result);
  })
);

app.get(
  "/api/subjects",
  requireSession,
  asyncHandler(async (req, res) => {
    const client = getClient(req.localSession);
    const data = await client.subjects(req.localSession.studentId);
    res.json({
      count: (data.subjects || []).length,
      subjects: data.subjects || []
    });
  })
);

app.get(
  "/api/periods",
  requireSession,
  asyncHandler(async (req, res) => {
    const client = getClient(req.localSession);
    const data = await client.periods(req.localSession.studentId);
    res.json(data);
  })
);

app.get(
  "/api/noticeboard",
  requireSession,
  asyncHandler(async (req, res) => {
    const client = getClient(req.localSession);
    const data = await client.noticeboard(req.localSession.studentId);
    res.json({
      count: (data.items || []).length,
      items: data.items || []
    });
  })
);

app.get(
  "/api/calendar",
  requireSession,
  asyncHandler(async (req, res) => {
    const client = getClient(req.localSession);
    const data = await client.calendar(req.localSession.studentId);
    res.json({
      count: (data.calendar || []).length,
      calendar: data.calendar || []
    });
  })
);

app.get(
  "/api/didactics",
  requireSession,
  asyncHandler(async (req, res) => {
    const client = getClient(req.localSession);
    const data = await client.didactics(req.localSession.studentId);
    res.json(data);
  })
);

app.get(
  "/api/documents",
  requireSession,
  asyncHandler(async (req, res) => {
    const client = getClient(req.localSession);
    const data = await client.documents(req.localSession.studentId);

    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const documents = (data.documents || []).map((document) => ({
      ...document,
      readUrl: `${baseUrl}/api/documents/read/${encodeURIComponent(document.hash)}`,
      downloadUrl: `${baseUrl}/api/documents/download/${encodeURIComponent(document.hash)}`
    }));

    res.json({
      ...data,
      documents
    });
  })
);

app.get(
  "/api/documents/status/:hash",
  requireSession,
  asyncHandler(async (req, res) => {
    const client = getClient(req.localSession);
    const data = await client.documentStatus(req.localSession.studentId, req.params.hash);
    res.json(data);
  })
);

app.get(
  "/api/documents/read/:hash",
  requireSession,
  asyncHandler(async (req, res) => {
    const client = getClient(req.localSession);
    const document = await client.readDocument(req.localSession.studentId, req.params.hash);
    const shouldDownload = ["1", "true", "yes"].includes(
      String(req.query.download || "").toLowerCase()
    );

    if (shouldDownload) {
      const fileName = sanitizeAttachmentFileName(req.query.filename, `${req.params.hash}.pdf`);
      res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    }

    res.setHeader("Content-Type", document.contentType);
    res.send(Buffer.from(document.data));
  })
);

app.get(
  "/api/documents/download/:hash",
  requireSession,
  asyncHandler(async (req, res) => {
    const client = getClient(req.localSession);
    const document = await client.readDocument(req.localSession.studentId, req.params.hash);
    const fileName = sanitizeAttachmentFileName(req.query.filename, `${req.params.hash}.pdf`);

    res.setHeader("Content-Type", document.contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.send(Buffer.from(document.data));
  })
);

app.post(
  "/api/raw",
  requireSession,
  asyncHandler(async (req, res) => {
    const { method = "GET", path, data } = req.body || {};
    const normalizedPath = normalizePath(path);

    if (!normalizedPath) {
      return res.status(400).json({
        error: "Invalid path. Use a path starting with /v1/"
      });
    }

    const upperMethod = String(method).toUpperCase();
    const client = getClient(req.localSession);

    if (upperMethod !== "GET" && upperMethod !== "POST") {
      return res.status(400).json({
        error: "Only GET and POST are supported"
      });
    }

    const result =
      upperMethod === "GET"
        ? await client.get(normalizedPath)
        : await client.post(normalizedPath, data);

    res.json({
      method: upperMethod,
      path: normalizedPath,
      data: result
    });
  })
);

app.get(
  "/api/overview",
  requireSession,
  asyncHandler(async (req, res) => {
    const client = getClient(req.localSession);
    const studentId = req.localSession.studentId;

    const results = await Promise.allSettled([
      client.studentCard(studentId),
      client.grades(studentId),
      client.lessonsToday(studentId),
      client.absences(studentId),
      client.notes(studentId)
    ]);

    const [card, grades, lessons, absences, notes] = results;

    const mapResult = (item) => {
      if (item.status === "fulfilled") {
        return { ok: true, data: item.value };
      }

      return {
        ok: false,
        error: toErrorObject(item.reason)
      };
    };

    const notesPayload = notes.status === "fulfilled" ? notes.value : {};
    const flatNotes = flattenNotesGroups(notesPayload);

    const gradesPayload = grades.status === "fulfilled" ? grades.value.grades || [] : [];

    res.json({
      studentId,
      card: mapResult(card),
      grades: {
        ...mapResult(grades),
        summary: buildGradesSummary(gradesPayload)
      },
      lessons: mapResult(lessons),
      absences: mapResult(absences),
      notes: {
        ...mapResult(notes),
        total: flatNotes.length,
        latest: flatNotes.slice(0, 5)
      }
    });
  })
);

app.use((err, req, res, next) => {
  const e = toErrorObject(err);
  res.status(e.status).json({
    error: e.message,
    remote: e.remote
  });
});

app.listen(config.port, () => {
  console.log(`cvv-api listening on http://localhost:${config.port}`);
});
