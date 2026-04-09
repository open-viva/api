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
  /^\/api\/chemediaho\/export$/,
  /^\/api\/chemediaho\/settings$/,
  /^\/api\/chemediaho\/overall_average_detail$/,
  /^\/api\/lessons$/,
  /^\/api\/absences$/,
  /^\/api\/agenda$/,
  /^\/api\/notes$/,
  /^\/api\/subjects$/,
  /^\/api\/periods$/,
  /^\/api\/noticeboard$/,
  /^\/api\/noticeboard\/download\/[^/]+(?:\/[^/]+)?$/,
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

const CHEMEDIAHO_ALLOWED_GRADES = [
  4, 4.25, 4.5, 4.75, 5, 5.25, 5.5, 5.75, 6, 6.25, 6.5, 6.75, 7, 7.25, 7.5, 7.75,
  8, 8.25, 8.5, 8.75, 9, 9.25, 9.5, 9.75, 10
];
const CHEMEDIAHO_GRADE_MIN = 1;
const CHEMEDIAHO_GRADE_MAX = 10;
const CHEMEDIAHO_DEFAULT_INCLUDE_BLUE_GRADES = false;
const CHEMEDIAHO_MAX_NUM_GRADES = 10;
const CHEMEDIAHO_MAX_SUGGESTIONS = 4;
const CHEMEDIAHO_SUGGESTION_IMPACT_WEIGHT = 0.1;

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

const toFiniteNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const parseBoolean = (value, fallback = false) => {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return value !== 0;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "y", "on"].includes(normalized)) {
      return true;
    }
    if (["0", "false", "no", "n", "off"].includes(normalized)) {
      return false;
    }
  }

  return fallback;
};

const getSessionIncludeBlueGrades = (session) => {
  if (typeof session?.includeBlueGrades === "boolean") {
    return session.includeBlueGrades;
  }

  return CHEMEDIAHO_DEFAULT_INCLUDE_BLUE_GRADES;
};

const isBlueGrade = (grade) => String(grade?.color || "").toLowerCase() === "blue";

const toPeriodNumber = (grade) => {
  const periodPos = toFiniteNumber(grade?.periodPos);
  if (periodPos === null) {
    return 1;
  }

  const adjusted = Math.floor(periodPos) - 1;
  return adjusted >= 1 ? adjusted : 1;
};

const getEffectiveGradeValues = (gradesList) => {
  const standalone = [];
  const componentsByEvent = new Map();

  for (const grade of gradesList || []) {
    const decimalValue = toFiniteNumber(grade?.decimalValue);
    if (decimalValue === null) {
      continue;
    }

    const componentDesc =
      typeof grade.componentDesc === "string" ? grade.componentDesc.trim() : "";

    if (!componentDesc) {
      standalone.push(decimalValue);
      continue;
    }

    const groupKey =
      findFirstNonEmpty(grade.evtId, grade.evtDate) || `component-${componentsByEvent.size + 1}`;

    const existingValues = componentsByEvent.get(groupKey) || [];
    existingValues.push(decimalValue);
    componentsByEvent.set(groupKey, existingValues);
  }

  const effectiveGrades = [...standalone];
  for (const values of componentsByEvent.values()) {
    if (values.length === 0) {
      continue;
    }

    effectiveGrades.push(values.reduce((sum, value) => sum + value, 0) / values.length);
  }

  return effectiveGrades;
};

const buildCheMediaHoGrades = (
  grades,
  { includeBlueGrades = CHEMEDIAHO_DEFAULT_INCLUDE_BLUE_GRADES } = {}
) => {
  const gradesAvr = {};

  for (const grade of grades || []) {
    const decimalValue = toFiniteNumber(grade?.decimalValue);
    if (decimalValue === null || grade?.canceled === true) {
      continue;
    }

    if (!includeBlueGrades && isBlueGrade(grade)) {
      continue;
    }

    const period = String(toPeriodNumber(grade));
    const subject = findFirstNonEmpty(grade.subjectDesc) || "Materia sconosciuta";

    if (!gradesAvr[period]) {
      gradesAvr[period] = {};
    }

    if (!gradesAvr[period][subject]) {
      gradesAvr[period][subject] = {
        count: 0,
        avr: 0,
        grades: []
      };
    }

    gradesAvr[period][subject].count += 1;
    gradesAvr[period][subject].grades.push({
      decimalValue,
      displayValue: findFirstNonEmpty(grade.displayValue) || String(decimalValue),
      evtDate: findFirstNonEmpty(grade.evtDate) || "",
      notesForFamily: findFirstNonEmpty(grade.notesForFamily) || "",
      componentDesc: findFirstNonEmpty(grade.componentDesc) || "",
      teacherName: findFirstNonEmpty(grade.teacherName) || "",
      isBlue: isBlueGrade(grade)
    });
  }

  for (const [period, subjects] of Object.entries(gradesAvr)) {
    const periodGrades = [];

    for (const [subject, subjectData] of Object.entries(subjects)) {
      if (subject === "period_avr") {
        continue;
      }

      const effectiveGrades = getEffectiveGradeValues(subjectData.grades);
      subjectData.avr =
        effectiveGrades.length > 0
          ? Number(
              (
                effectiveGrades.reduce((sum, value) => sum + value, 0) / effectiveGrades.length
              ).toFixed(2)
            )
          : 0;

      periodGrades.push(...effectiveGrades);
    }

    gradesAvr[period].period_avr =
      periodGrades.length > 0
        ? Number((periodGrades.reduce((sum, value) => sum + value, 0) / periodGrades.length).toFixed(2))
        : 0;
  }

  const allGrades = [];
  for (const [period, subjects] of Object.entries(gradesAvr)) {
    if (period === "all_avr") {
      continue;
    }

    for (const [subject, subjectData] of Object.entries(subjects)) {
      if (subject === "period_avr") {
        continue;
      }

      allGrades.push(...getEffectiveGradeValues(subjectData.grades));
    }
  }

  gradesAvr.all_avr =
    allGrades.length > 0
      ? Number((allGrades.reduce((sum, value) => sum + value, 0) / allGrades.length).toFixed(2))
      : 0;

  return gradesAvr;
};

const getPeriodKeys = (gradesAvr) =>
  Object.keys(gradesAvr)
    .filter((key) => key !== "all_avr")
    .sort((a, b) => Number(a) - Number(b));

const findSubjectKey = (periodData, subjectName) => {
  const requestedSubject = findFirstNonEmpty(subjectName);
  if (!requestedSubject || !periodData || typeof periodData !== "object") {
    return null;
  }

  if (Object.prototype.hasOwnProperty.call(periodData, requestedSubject)) {
    return requestedSubject;
  }

  const normalizedRequested = requestedSubject.toLowerCase();
  return (
    Object.keys(periodData).find(
      (subject) => subject !== "period_avr" && subject.toLowerCase() === normalizedRequested
    ) || null
  );
};

const getAllEffectiveGrades = (gradesAvr) => {
  const allGrades = [];

  for (const period of getPeriodKeys(gradesAvr)) {
    const periodData = gradesAvr[period] || {};
    for (const [subject, subjectData] of Object.entries(periodData)) {
      if (subject === "period_avr") {
        continue;
      }

      allGrades.push(...getEffectiveGradeValues(subjectData.grades));
    }
  }

  return allGrades;
};

const collectSubjectGradesAcrossPeriods = (gradesAvr, subjectName) => {
  const requestedSubject = findFirstNonEmpty(subjectName);
  if (!requestedSubject) {
    return { subject: null, grades: [] };
  }

  const normalizedRequested = requestedSubject.toLowerCase();
  const collectedGrades = [];
  let resolvedSubject = null;

  for (const period of getPeriodKeys(gradesAvr)) {
    const periodData = gradesAvr[period] || {};
    for (const [subject, subjectData] of Object.entries(periodData)) {
      if (subject === "period_avr") {
        continue;
      }

      if (subject.toLowerCase() !== normalizedRequested) {
        continue;
      }

      if (!resolvedSubject) {
        resolvedSubject = subject;
      }

      collectedGrades.push(...getEffectiveGradeValues(subjectData.grades));
    }
  }

  return {
    subject: resolvedSubject,
    grades: collectedGrades
  };
};

const roundToAllowedGrade = (grade) => {
  if (!Number.isFinite(grade)) {
    return CHEMEDIAHO_ALLOWED_GRADES[0];
  }

  if (grade <= CHEMEDIAHO_ALLOWED_GRADES[0]) {
    return CHEMEDIAHO_ALLOWED_GRADES[0];
  }

  const maxAllowed = CHEMEDIAHO_ALLOWED_GRADES[CHEMEDIAHO_ALLOWED_GRADES.length - 1];
  if (grade >= maxAllowed) {
    return maxAllowed;
  }

  return CHEMEDIAHO_ALLOWED_GRADES.reduce((closest, current) => {
    return Math.abs(current - grade) < Math.abs(closest - grade) ? current : closest;
  }, CHEMEDIAHO_ALLOWED_GRADES[0]);
};

const calculateOptimalGradesNeeded = (currentTotal, currentCount, targetAverage) => {
  if (currentCount > 0 && currentTotal / currentCount >= targetAverage) {
    return [0, []];
  }

  let minGradesNeeded = 1;
  if (targetAverage < CHEMEDIAHO_GRADE_MAX) {
    const numerator = targetAverage * currentCount - currentTotal;
    const denominator = CHEMEDIAHO_GRADE_MAX - targetAverage;
    if (denominator > 0) {
      minGradesNeeded = Math.max(1, Math.floor(numerator / denominator) + 1);
    }
  }

  minGradesNeeded = Math.min(minGradesNeeded, 5);

  let requiredSum = targetAverage * (currentCount + minGradesNeeded) - currentTotal;
  let requiredAverageGrade = requiredSum / minGradesNeeded;

  while (requiredAverageGrade > CHEMEDIAHO_GRADE_MAX && minGradesNeeded < CHEMEDIAHO_MAX_NUM_GRADES) {
    minGradesNeeded += 1;
    requiredSum = targetAverage * (currentCount + minGradesNeeded) - currentTotal;
    requiredAverageGrade = requiredSum / minGradesNeeded;
  }

  return [
    minGradesNeeded,
    Array.from({ length: minGradesNeeded }, () => Number(requiredAverageGrade.toFixed(1)))
  ];
};

const calculatePeriodSubjectSuggestions = (gradesAvr, period, targetAverage, numGrades) => {
  const periodData = gradesAvr[period];
  if (!periodData || typeof periodData !== "object") {
    return [];
  }

  const periodSubjects = Object.keys(periodData).filter((subject) => subject !== "period_avr");
  const allPeriodGrades = periodSubjects.flatMap((subject) =>
    getEffectiveGradeValues(periodData[subject].grades)
  );

  if (allPeriodGrades.length === 0) {
    return [];
  }

  const currentPeriodTotal = allPeriodGrades.reduce((sum, value) => sum + value, 0);
  const currentPeriodAverage = currentPeriodTotal / allPeriodGrades.length;
  if (currentPeriodAverage >= targetAverage) {
    return [];
  }

  const requiredSum = targetAverage * (allPeriodGrades.length + numGrades) - currentPeriodTotal;
  const baselineRequiredGrade = requiredSum / numGrades;

  const suggestions = [];
  for (const subject of periodSubjects) {
    const subjectGrades = getEffectiveGradeValues(periodData[subject].grades);
    if (subjectGrades.length === 0) {
      continue;
    }

    const currentAverage = subjectGrades.reduce((sum, value) => sum + value, 0) / subjectGrades.length;
    const impactFactor = (1 / (subjectGrades.length + numGrades)) * 100;
    const difficulty = baselineRequiredGrade - impactFactor * CHEMEDIAHO_SUGGESTION_IMPACT_WEIGHT;

    suggestions.push({
      subject,
      current_average: Number(currentAverage.toFixed(2)),
      required_grade: roundToAllowedGrade(baselineRequiredGrade),
      raw_required_grade: Number(baselineRequiredGrade.toFixed(2)),
      num_current_grades: subjectGrades.length,
      difficulty: Number(difficulty.toFixed(2)),
      impact: Number(impactFactor.toFixed(2)),
      is_achievable: baselineRequiredGrade <= CHEMEDIAHO_GRADE_MAX
    });
  }

  suggestions.sort((a, b) => {
    if (a.is_achievable !== b.is_achievable) {
      return a.is_achievable ? -1 : 1;
    }

    return a.difficulty - b.difficulty;
  });

  return suggestions.slice(0, CHEMEDIAHO_MAX_SUGGESTIONS);
};

const calculateOverallSubjectSuggestions = (gradesAvr, targetAverage, numGrades) => {
  const allGrades = getAllEffectiveGrades(gradesAvr);
  if (allGrades.length === 0) {
    return [];
  }

  const currentTotal = allGrades.reduce((sum, value) => sum + value, 0);
  const currentCount = allGrades.length;
  const requiredSum = targetAverage * (currentCount + numGrades) - currentTotal;
  const baselineRequiredGrade = requiredSum / numGrades;

  const subjectsMap = new Map();
  for (const period of getPeriodKeys(gradesAvr)) {
    const periodData = gradesAvr[period] || {};

    for (const [subject, subjectData] of Object.entries(periodData)) {
      if (subject === "period_avr") {
        continue;
      }

      const normalized = subject.toLowerCase();
      const entry = subjectsMap.get(normalized) || {
        subject,
        grades: []
      };

      entry.grades.push(...getEffectiveGradeValues(subjectData.grades));
      subjectsMap.set(normalized, entry);
    }
  }

  const suggestions = [];
  for (const entry of subjectsMap.values()) {
    if (entry.grades.length === 0) {
      continue;
    }

    const currentAverage = entry.grades.reduce((sum, value) => sum + value, 0) / entry.grades.length;
    const impactFactor = (1 / (entry.grades.length + numGrades)) * 100;
    const difficulty = baselineRequiredGrade - impactFactor * CHEMEDIAHO_SUGGESTION_IMPACT_WEIGHT;

    suggestions.push({
      subject: entry.subject,
      current_average: Number(currentAverage.toFixed(2)),
      required_grade: roundToAllowedGrade(baselineRequiredGrade),
      raw_required_grade: Number(baselineRequiredGrade.toFixed(2)),
      num_current_grades: entry.grades.length,
      difficulty: Number(difficulty.toFixed(2)),
      impact: Number(impactFactor.toFixed(2)),
      is_achievable: baselineRequiredGrade <= CHEMEDIAHO_GRADE_MAX
    });
  }

  suggestions.sort((a, b) => {
    if (a.is_achievable !== b.is_achievable) {
      return a.is_achievable ? -1 : 1;
    }

    return a.difficulty - b.difficulty;
  });

  return suggestions.slice(0, CHEMEDIAHO_MAX_SUGGESTIONS);
};

const getGoalMessage = (rawRequiredGrade, displayGrade, targetAverage, currentAverage, numGrades) => {
  const gradeText = numGrades === 1 ? "un voto" : `${numGrades} voti`;

  if (currentAverage >= targetAverage) {
    return `Obiettivo gia raggiunto: media attuale ${currentAverage.toFixed(2)}.`;
  }

  if (rawRequiredGrade < CHEMEDIAHO_GRADE_MIN) {
    return `Sei gia sopra l'obiettivo: anche con voti bassi raggiungi ${targetAverage}.`;
  }

  if (rawRequiredGrade > CHEMEDIAHO_GRADE_MAX) {
    return `Obiettivo difficile: con ${gradeText} non arrivi a ${targetAverage}.`;
  }

  if (rawRequiredGrade >= 9) {
    return `Serve molto impegno: punta ad almeno ${displayGrade} per ${gradeText}.`;
  }

  if (rawRequiredGrade >= 7) {
    return `Obiettivo fattibile: con ${gradeText} da ${displayGrade} puoi arrivare a ${targetAverage}.`;
  }

  return `Obiettivo raggiungibile: con ${gradeText} da ${displayGrade} puoi arrivare a ${targetAverage}.`;
};

const getPredictMessage = (change, predictedAverage, numGrades) => {
  const gradeText = numGrades === 1 ? "un voto" : `${numGrades} voti`;

  if (change > 0.5) {
    return `Ottimo: con ${gradeText} la media salirebbe a ${predictedAverage.toFixed(2)} (${change.toFixed(2)}).`;
  }

  if (change > 0) {
    return `Bene: con ${gradeText} la media migliorerebbe a ${predictedAverage.toFixed(2)} (${change.toFixed(2)}).`;
  }

  if (change === 0) {
    return `Con ${gradeText} la media resterebbe stabile a ${predictedAverage.toFixed(2)}.`;
  }

  if (change > -0.5) {
    return `Attenzione: con ${gradeText} la media scenderebbe a ${predictedAverage.toFixed(2)} (${change.toFixed(2)}).`;
  }

  return `Attenzione: con ${gradeText} la media scenderebbe sensibilmente a ${predictedAverage.toFixed(2)} (${change.toFixed(2)}).`;
};

const getPeriodSuggestionMessage = (suggestions, targetAverage, numGrades, period) => {
  if (!suggestions.length) {
    return `Nessun suggerimento disponibile per il periodo ${period}.`;
  }

  const gradeText = numGrades === 1 ? "un voto" : `${numGrades} voti`;
  const top = suggestions[0];

  if (top.required_grade > CHEMEDIAHO_GRADE_MAX) {
    return `Raggiungere ${targetAverage} nel periodo ${period} e molto difficile.`;
  }

  return `Concentrati su ${top.subject}: servono ${gradeText} da ${top.required_grade}.`;
};

const getOverallSuggestionMessage = (suggestions, targetAverage, numGrades) => {
  if (!suggestions.length) {
    return "Nessuna materia disponibile per il calcolo.";
  }

  const gradeText = numGrades === 1 ? "un voto" : `${numGrades} voti`;
  const top = suggestions[0];

  if (top.required_grade > CHEMEDIAHO_GRADE_MAX) {
    return `Raggiungere la media generale ${targetAverage} e molto difficile.`;
  }

  return `Concentrati su ${top.subject}: servono ${gradeText} da ${top.required_grade}.`;
};

const getGoalOverallMessage = (
  rawRequiredGrade,
  displayGrade,
  targetAverage,
  currentAverage,
  numGrades,
  subject
) => {
  const gradeText = numGrades === 1 ? "un voto" : `${numGrades} voti`;

  if (currentAverage >= targetAverage) {
    return `Obiettivo gia raggiunto: media generale ${currentAverage.toFixed(2)}.`;
  }

  if (rawRequiredGrade > CHEMEDIAHO_GRADE_MAX) {
    return `Obiettivo difficile: ${gradeText} in ${subject} non bastano per arrivare a ${targetAverage}.`;
  }

  if (rawRequiredGrade >= 9) {
    return `Serve molto impegno: ${gradeText} da almeno ${displayGrade} in ${subject}.`;
  }

  return `Obiettivo fattibile: ${gradeText} da ${displayGrade} in ${subject}.`;
};

const getPredictOverallMessage = (change, predictedAverage, numGrades, subject) => {
  const gradeText = numGrades === 1 ? "un voto" : `${numGrades} voti`;

  if (change > 0.5) {
    return `Ottimo: con ${gradeText} in ${subject} la media generale salirebbe a ${predictedAverage.toFixed(2)}.`;
  }

  if (change > 0) {
    return `Bene: con ${gradeText} in ${subject} la media generale migliorerebbe a ${predictedAverage.toFixed(2)}.`;
  }

  if (change === 0) {
    return `Con ${gradeText} in ${subject} la media generale resterebbe stabile a ${predictedAverage.toFixed(2)}.`;
  }

  if (change > -0.5) {
    return `Attenzione: con ${gradeText} in ${subject} la media generale scenderebbe a ${predictedAverage.toFixed(2)}.`;
  }

  return `Attenzione: con ${gradeText} in ${subject} la media generale scenderebbe sensibilmente a ${predictedAverage.toFixed(2)}.`;
};

const csvEscape = (value) => {
  const text = value === undefined || value === null ? "" : String(value);
  if (!/[",\n\r]/.test(text)) {
    return text;
  }

  return `"${text.replace(/"/g, '""')}"`;
};

const buildCsvFromGradesAvr = (gradesAvr) => {
  const rows = [["Periodo", "Materia", "Voto", "Data", "Tipo", "Docente", "Note"]];

  for (const period of getPeriodKeys(gradesAvr)) {
    const periodData = gradesAvr[period] || {};
    const subjects = Object.keys(periodData)
      .filter((subject) => subject !== "period_avr")
      .sort((a, b) => a.localeCompare(b));

    for (const subject of subjects) {
      const subjectData = periodData[subject];
      for (const grade of subjectData.grades || []) {
        rows.push([
          `Periodo ${period}`,
          subject,
          grade.decimalValue,
          grade.evtDate || "",
          grade.componentDesc || "",
          grade.teacherName || "",
          grade.notesForFamily || ""
        ]);
      }
    }
  }

  return rows.map((row) => row.map(csvEscape).join(",")).join("\n");
};

const nowTimestamp = (value = new Date()) => {
  const twoDigits = (n) => String(n).padStart(2, "0");
  return [
    value.getFullYear(),
    twoDigits(value.getMonth() + 1),
    twoDigits(value.getDate()),
    "_",
    twoDigits(value.getHours()),
    twoDigits(value.getMinutes()),
    twoDigits(value.getSeconds())
  ].join("");
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
    includeBlueGrades: CHEMEDIAHO_DEFAULT_INCLUDE_BLUE_GRADES,
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

const loadCheMediaHoGrades = async (session, options = {}) => {
  const includeBlueGrades =
    typeof options.includeBlueGrades === "boolean"
      ? options.includeBlueGrades
      : getSessionIncludeBlueGrades(session);

  const client = getClient(session);
  const data = await client.grades(session.studentId);
  const grades = Array.isArray(data?.grades) ? data.grades : [];

  return {
    includeBlueGrades,
    grades,
    gradesAvr: buildCheMediaHoGrades(grades, { includeBlueGrades })
  };
};

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "cvv-api",
    sessions: sessions.size,
    baseUrl: config.classevivaBaseUrl,
    version: config.version
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

app.post(
  "/api/chemediaho/logout",
  requireSession,
  asyncHandler(async (req, res) => {
    sessions.delete(req.localSessionId);
    res.json({ success: true, ok: true });
  })
);

app.get(
  "/api/chemediaho/export",
  requireSession,
  asyncHandler(async (req, res) => {
    res.json({ authenticated: true });
  })
);

app.get("/api/chemediaho/settings", (req, res) => {
  res.json({
    version: config.version
  });
});

app.get(
  "/api/chemediaho/overall_average_detail",
  requireSession,
  asyncHandler(async (req, res) => {
    const { includeBlueGrades, gradesAvr } = await loadCheMediaHoGrades(req.localSession);

    res.json({
      include_blue_grades: includeBlueGrades,
      ...gradesAvr
    });
  })
);

app.post(
  "/api/chemediaho/set_blue_grade_preference",
  requireSession,
  asyncHandler(async (req, res) => {
    const payload = req.body && typeof req.body === "object" ? req.body : {};
    const includeBlueGrades = parseBoolean(
      payload.include_blue_grades,
      CHEMEDIAHO_DEFAULT_INCLUDE_BLUE_GRADES
    );

    req.localSession.includeBlueGrades = includeBlueGrades;
    sessions.set(req.localSessionId, req.localSession);

    const { gradesAvr } = await loadCheMediaHoGrades(req.localSession, { includeBlueGrades });

    res.json({
      success: true,
      include_blue_grades: includeBlueGrades,
      all_avr: gradesAvr.all_avr
    });
  })
);

app.post(
  "/api/chemediaho/calculate_goal",
  requireSession,
  asyncHandler(async (req, res) => {
    const payload = req.body && typeof req.body === "object" ? req.body : {};
    const period = findFirstNonEmpty(payload.period);
    const subject = findFirstNonEmpty(payload.subject);
    const targetAverage = toFiniteNumber(payload.target_average);
    const parsedNumGrades = toFiniteNumber(payload.num_grades);
    const numGrades = parsedNumGrades === null ? 1 : Math.trunc(parsedNumGrades);

    if (!period) {
      return res.status(400).json({ error: "Periodo non trovato" });
    }

    if (targetAverage === null || targetAverage < CHEMEDIAHO_GRADE_MIN || targetAverage > CHEMEDIAHO_GRADE_MAX) {
      return res.status(400).json({
        error: "La media target deve essere tra 1 e 10"
      });
    }

    if (!Number.isInteger(numGrades) || numGrades < 1 || numGrades > CHEMEDIAHO_MAX_NUM_GRADES) {
      return res.status(400).json({
        error: "Il numero di voti deve essere tra 1 e 10"
      });
    }

    const { gradesAvr } = await loadCheMediaHoGrades(req.localSession);
    const periodData = gradesAvr[period];

    if (!periodData || typeof periodData !== "object") {
      return res.status(400).json({ error: "Periodo non trovato" });
    }

    if (!subject) {
      const suggestions = calculatePeriodSubjectSuggestions(gradesAvr, period, targetAverage, numGrades);
      return res.json({
        success: true,
        period,
        target_average: targetAverage,
        suggestions,
        num_grades: numGrades,
        message: getPeriodSuggestionMessage(suggestions, targetAverage, numGrades, period)
      });
    }

    const subjectKey = findSubjectKey(periodData, subject);
    if (!subjectKey || subjectKey === "period_avr") {
      return res.status(400).json({
        error: "Materia non trovata nel periodo selezionato"
      });
    }

    const subjectData = periodData[subjectKey];
    const currentGrades = getEffectiveGradeValues(subjectData.grades);
    if (currentGrades.length === 0) {
      return res.status(400).json({
        error: "Nessun voto disponibile per questa materia"
      });
    }

    const currentSum = currentGrades.reduce((sum, value) => sum + value, 0);
    const currentAverage =
      toFiniteNumber(subjectData.avr) || (currentGrades.length > 0 ? currentSum / currentGrades.length : 0);

    if (currentAverage >= targetAverage) {
      return res.json({
        success: true,
        current_average: Number(currentAverage.toFixed(2)),
        target_average: targetAverage,
        required_grade: null,
        required_grades: [],
        current_grades_count: currentGrades.length,
        achievable: true,
        already_achieved: true,
        subject: subjectKey,
        message: `Obiettivo gia raggiunto: media attuale ${currentAverage.toFixed(2)}.`
      });
    }

    const requiredSum = targetAverage * (currentGrades.length + numGrades) - currentSum;
    const requiredAverageGrade = requiredSum / numGrades;
    const displayGrade = roundToAllowedGrade(requiredAverageGrade);

    return res.json({
      success: true,
      current_average: Number(currentAverage.toFixed(2)),
      target_average: targetAverage,
      required_grade: displayGrade,
      required_grades: Array.from({ length: numGrades }, () => displayGrade),
      current_grades_count: currentGrades.length,
      achievable:
        requiredAverageGrade >= CHEMEDIAHO_GRADE_MIN && requiredAverageGrade <= CHEMEDIAHO_GRADE_MAX,
      already_achieved: false,
      subject: subjectKey,
      message: getGoalMessage(
        requiredAverageGrade,
        displayGrade,
        targetAverage,
        currentAverage,
        numGrades
      )
    });
  })
);

app.post(
  "/api/chemediaho/predict_average",
  requireSession,
  asyncHandler(async (req, res) => {
    const payload = req.body && typeof req.body === "object" ? req.body : {};
    const period = findFirstNonEmpty(payload.period);
    const subject = findFirstNonEmpty(payload.subject);
    const predictedGrades = Array.isArray(payload.predicted_grades) ? payload.predicted_grades : [];

    if (!period || !subject) {
      return res.status(400).json({ error: "Materia o periodo non trovato" });
    }

    if (!predictedGrades.length) {
      return res.status(400).json({ error: "Inserisci almeno un voto previsto" });
    }

    const normalizedPredictedGrades = predictedGrades.map((grade) => toFiniteNumber(grade));
    if (
      normalizedPredictedGrades.some(
        (grade) => grade === null || grade < CHEMEDIAHO_GRADE_MIN || grade > CHEMEDIAHO_GRADE_MAX
      )
    ) {
      return res.status(400).json({ error: "Tutti i voti devono essere tra 1 e 10" });
    }

    const { gradesAvr } = await loadCheMediaHoGrades(req.localSession);
    const periodData = gradesAvr[period];
    const subjectKey = findSubjectKey(periodData, subject);

    if (!periodData || !subjectKey || subjectKey === "period_avr") {
      return res.status(400).json({ error: "Materia o periodo non trovato" });
    }

    const currentGrades = getEffectiveGradeValues(periodData[subjectKey].grades);
    if (!currentGrades.length) {
      return res.status(400).json({ error: "Nessun voto disponibile per questa materia" });
    }

    const currentAverage =
      toFiniteNumber(periodData[subjectKey].avr) ||
      currentGrades.reduce((sum, value) => sum + value, 0) / currentGrades.length;

    const allGrades = [...currentGrades, ...normalizedPredictedGrades];
    const predictedAverage = allGrades.reduce((sum, value) => sum + value, 0) / allGrades.length;
    const change = predictedAverage - currentAverage;

    return res.json({
      success: true,
      current_average: Number(currentAverage.toFixed(2)),
      predicted_average: Number(predictedAverage.toFixed(2)),
      change: Number(change.toFixed(2)),
      num_predicted_grades: normalizedPredictedGrades.length,
      message: getPredictMessage(change, predictedAverage, normalizedPredictedGrades.length)
    });
  })
);

app.post(
  "/api/chemediaho/calculate_goal_overall",
  requireSession,
  asyncHandler(async (req, res) => {
    const payload = req.body && typeof req.body === "object" ? req.body : {};
    const subject = findFirstNonEmpty(payload.subject);
    const targetAverage = toFiniteNumber(payload.target_average);
    const parsedNumGrades = toFiniteNumber(payload.num_grades);

    if (targetAverage === null || targetAverage < CHEMEDIAHO_GRADE_MIN || targetAverage > CHEMEDIAHO_GRADE_MAX) {
      return res.status(400).json({ error: "La media target deve essere tra 1 e 10" });
    }

    const { gradesAvr } = await loadCheMediaHoGrades(req.localSession);
    const currentOverallAverage = toFiniteNumber(gradesAvr.all_avr) || 0;

    if (currentOverallAverage >= targetAverage) {
      return res.json({
        success: true,
        current_overall_average: Number(currentOverallAverage.toFixed(2)),
        target_average: targetAverage,
        suggestions: [],
        num_grades: 0,
        auto_calculated: true,
        already_achieved: true,
        message: `Obiettivo gia raggiunto: media generale ${currentOverallAverage.toFixed(2)}.`
      });
    }

    const allGrades = getAllEffectiveGrades(gradesAvr);
    if (!allGrades.length) {
      return res.status(400).json({ error: "Nessun voto disponibile" });
    }

    const currentTotal = allGrades.reduce((sum, value) => sum + value, 0);
    const currentCount = allGrades.length;

    let numGrades;
    let autoCalculated;

    if (parsedNumGrades === null) {
      [numGrades] = calculateOptimalGradesNeeded(currentTotal, currentCount, targetAverage);
      autoCalculated = true;
    } else {
      numGrades = Math.trunc(parsedNumGrades);
      autoCalculated = false;
    }

    if (!Number.isInteger(numGrades) || numGrades < 1 || numGrades > CHEMEDIAHO_MAX_NUM_GRADES) {
      return res.status(400).json({
        error: "Il numero di voti deve essere tra 1 e 10"
      });
    }

    const requiredSum = targetAverage * (currentCount + numGrades) - currentTotal;
    const requiredAverageGrade = requiredSum / numGrades;

    if (!subject) {
      const suggestions = calculateOverallSubjectSuggestions(gradesAvr, targetAverage, numGrades);

      return res.json({
        success: true,
        current_overall_average: Number(currentOverallAverage.toFixed(2)),
        target_average: targetAverage,
        suggestions,
        num_grades: numGrades,
        auto_calculated: autoCalculated,
        message: getOverallSuggestionMessage(suggestions, targetAverage, numGrades)
      });
    }

    const subjectData = collectSubjectGradesAcrossPeriods(gradesAvr, subject);
    if (!subjectData.subject || !subjectData.grades.length) {
      return res.status(400).json({ error: "Materia non trovata" });
    }

    const displayGrade = roundToAllowedGrade(requiredAverageGrade);

    return res.json({
      success: true,
      current_overall_average: Number(currentOverallAverage.toFixed(2)),
      target_average: targetAverage,
      required_grade: displayGrade,
      required_grades: Array.from({ length: numGrades }, () => displayGrade),
      current_grades_count: currentCount,
      achievable:
        requiredAverageGrade >= CHEMEDIAHO_GRADE_MIN && requiredAverageGrade <= CHEMEDIAHO_GRADE_MAX,
      subject: subjectData.subject,
      message: getGoalOverallMessage(
        requiredAverageGrade,
        displayGrade,
        targetAverage,
        currentOverallAverage,
        numGrades,
        subjectData.subject
      )
    });
  })
);

app.post(
  "/api/chemediaho/predict_average_overall",
  requireSession,
  asyncHandler(async (req, res) => {
    const payload = req.body && typeof req.body === "object" ? req.body : {};
    const period = findFirstNonEmpty(payload.period);
    const subject = findFirstNonEmpty(payload.subject);
    const predictedGrades = Array.isArray(payload.predicted_grades) ? payload.predicted_grades : [];

    if (!period || !subject) {
      return res.status(400).json({ error: "Materia o periodo non trovato" });
    }

    if (!predictedGrades.length) {
      return res.status(400).json({ error: "Inserisci almeno un voto previsto" });
    }

    const normalizedPredictedGrades = predictedGrades.map((grade) => toFiniteNumber(grade));
    if (
      normalizedPredictedGrades.some(
        (grade) => grade === null || grade < CHEMEDIAHO_GRADE_MIN || grade > CHEMEDIAHO_GRADE_MAX
      )
    ) {
      return res.status(400).json({ error: "Tutti i voti devono essere tra 1 e 10" });
    }

    const { gradesAvr } = await loadCheMediaHoGrades(req.localSession);
    const periodData = gradesAvr[period];
    const subjectKey = findSubjectKey(periodData, subject);

    if (!periodData || !subjectKey || subjectKey === "period_avr") {
      return res.status(400).json({ error: "Materia o periodo non trovato" });
    }

    const allGrades = getAllEffectiveGrades(gradesAvr);
    if (!allGrades.length) {
      return res.status(400).json({ error: "Nessun voto disponibile" });
    }

    const currentOverallAverage = toFiniteNumber(gradesAvr.all_avr) || 0;
    const predictedOverallAverage =
      [...allGrades, ...normalizedPredictedGrades].reduce((sum, value) => sum + value, 0) /
      (allGrades.length + normalizedPredictedGrades.length);
    const change = predictedOverallAverage - currentOverallAverage;

    return res.json({
      success: true,
      current_overall_average: Number(currentOverallAverage.toFixed(2)),
      predicted_overall_average: Number(predictedOverallAverage.toFixed(2)),
      change: Number(change.toFixed(2)),
      num_predicted_grades: normalizedPredictedGrades.length,
      subject: subjectKey,
      period,
      message: getPredictOverallMessage(
        change,
        predictedOverallAverage,
        normalizedPredictedGrades.length,
        subjectKey
      )
    });
  })
);

app.post(
  "/api/chemediaho/export/csv",
  requireSession,
  asyncHandler(async (req, res) => {
    const { gradesAvr } = await loadCheMediaHoGrades(req.localSession);
    const csv = buildCsvFromGradesAvr(gradesAvr);
    const fileName = `voti_${nowTimestamp()}.csv`;

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename=\"${fileName}\"`);
    res.send(csv);
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

    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const items = (data.items || []).map((item) => {
      const eventCode = findFirstNonEmpty(item.evtCode) || "CF";
      const attachments = (item.attachments || []).map((attachment) => {
        const attachNum = attachment.attachNum;
        const downloadUrl =
          `${baseUrl}/api/noticeboard/download/${encodeURIComponent(item.pubId)}` +
          `/${encodeURIComponent(attachNum)}?eventCode=${encodeURIComponent(eventCode)}`;

        return {
          ...attachment,
          downloadUrl
        };
      });

      return {
        ...item,
        attachments,
        defaultDownloadUrl:
          attachments.length > 0
            ? attachments[0].downloadUrl
            : `${baseUrl}/api/noticeboard/download/${encodeURIComponent(item.pubId)}?eventCode=${encodeURIComponent(eventCode)}`
      };
    });

    res.json({
      count: items.length,
      items
    });
  })
);

app.get(
  "/api/noticeboard/download/:pubId/:attachNum?",
  requireSession,
  asyncHandler(async (req, res) => {
    const client = getClient(req.localSession);
    const studentId = req.localSession.studentId;

    const pubId = String(req.params.pubId);
    const requestedEventCode = findFirstNonEmpty(req.query.eventCode, req.body?.eventCode);
    const requestedAttachNum = findFirstNonEmpty(
      req.params.attachNum,
      req.query.attachNum,
      req.body?.attachNum
    );

    const noticeboardData = await client.noticeboard(studentId);
    const item = (noticeboardData.items || []).find((current) => String(current.pubId) === pubId);

    if (!item && !requestedEventCode) {
      return res.status(404).json({
        error: "Noticeboard item not found",
        hint: "Provide a valid pubId or pass eventCode explicitly"
      });
    }

    const eventCode = requestedEventCode || findFirstNonEmpty(item?.evtCode) || "CF";
    const attachments = item?.attachments || [];
    const attachNum =
      requestedAttachNum ||
      (attachments.length > 0 ? String(attachments[0].attachNum) : "101");

    const matchedAttachment = attachments.find(
      (attachment) => String(attachment.attachNum) === String(attachNum)
    );
    const fallbackFileName = `circolare_${pubId}_${attachNum}.pdf`;
    const fileName = sanitizeAttachmentFileName(
      findFirstNonEmpty(req.query.filename, req.body?.filename),
      matchedAttachment?.fileName || fallbackFileName
    );

    const attachment = await client.noticeboardAttachment(studentId, eventCode, pubId, attachNum);

    res.setHeader("Content-Type", attachment.contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.send(Buffer.from(attachment.data));
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
