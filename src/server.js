import axios from "axios";
import cors from "cors";
import express from "express";
import multer from "multer";
import { v4 as uuidv4 } from "uuid";
import { ClassevivaClient } from "./classevivaClient.js";
import { config } from "./config.js";
import { flattenNotesGroups, toStudentId, withDefaultRange } from "./utils.js";

// ─── constants
const ALLOWED_GRADES = [
  4,4.25,4.5,4.75,5,5.25,5.5,5.75,6,6.25,6.5,6.75,7,7.25,7.5,7.75,
  8,8.25,8.5,8.75,9,9.25,9.5,9.75,10
];
const G_MIN = 1, G_MAX = 10;
const DEFAULT_BLUE = false;
const MAX_GRADES = 10, MAX_SUGGESTIONS = 4, IMPACT_W = 0.1;

// ─── tiny helpers 
const findFirst = (...vals) => {
  for (const v of vals) {
    const s = v === undefined || v === null ? "" : String(v).trim();
    if (s) return s;
  }
  return null;
};

const toNum = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };

const parseBool = (v, fb = false) => {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (["1","true","yes","y","on"].includes(s)) return true;
    if (["0","false","no","n","off"].includes(s)) return false;
  }
  return fb;
};

const sanitizeFilename = (v, fb = "document.pdf") =>
  (findFirst(v, fb) || fb).replace(/[^a-zA-Z0-9._-]/g, "_");

const csvEscape = v => {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const nowTimestamp = (d = new Date()) => {
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

// ─── grades math
const isBlue = g => String(g?.color||"").toLowerCase() === "blue";
const toPeriod = g => { const p = Math.floor(toNum(g?.periodPos)||1)-1; return String(p>=1?p:1); };

const getEffective = grades => {
  const standalone = [], byEvent = new Map();
  for (const g of grades||[]) {
    const v = toNum(g?.decimalValue);
    if (v === null) continue;
    const cd = typeof g.componentDesc==="string" ? g.componentDesc.trim() : "";
    if (!cd) { standalone.push(v); continue; }
    const key = findFirst(g.evtId, g.evtDate) || `c-${byEvent.size+1}`;
    byEvent.set(key, [...(byEvent.get(key)||[]), v]);
  }
  return [...standalone, ...[...byEvent.values()].map(vs => vs.reduce((a,b)=>a+b,0)/vs.length)];
};

const getEffectiveValid = grades =>
  getEffective(grades).filter(v => Number.isFinite(v) && v>=G_MIN && v<=G_MAX);

const avg = (vals, decimals=2) =>
  vals.length ? Number((vals.reduce((a,b)=>a+b,0)/vals.length).toFixed(decimals)) : null;

const roundToAllowed = g => {
  if (!Number.isFinite(g)) return ALLOWED_GRADES[0];
  if (g <= ALLOWED_GRADES[0]) return ALLOWED_GRADES[0];
  const mx = ALLOWED_GRADES[ALLOWED_GRADES.length-1];
  if (g >= mx) return mx;
  return ALLOWED_GRADES.reduce((c,v) => Math.abs(v-g)<Math.abs(c-g)?v:c, ALLOWED_GRADES[0]);
};

const buildGradesSummary = grades => {
  const valid = grades.filter(g => typeof g.decimalValue==="number" && g.canceled!==true);
  return { total: grades.length, validForAverage: valid.length, average: avg(valid.map(g=>g.decimalValue)) };
};

const buildGradesAverages = grades => {
  const valid = grades.filter(g => typeof g.decimalValue==="number" && Number.isFinite(g.decimalValue) && g.canceled!==true);
  const compute = (sum,count) => count>0 ? Number((sum/count).toFixed(2)) : null;
  const totalSum = valid.reduce((a,g)=>a+g.decimalValue,0);
  const periodMap = new Map(), subjectMap = new Map();
  for (const g of valid) {
    const pPos = Number.isFinite(g.periodPos)?g.periodPos:null;
    const pDesc = typeof g.periodDesc==="string"&&g.periodDesc.trim()?g.periodDesc.trim():"Senza periodo";
    const pk = `${pPos??"none"}|${pDesc}`;
    const pe = periodMap.get(pk)||{periodPos:pPos,periodDesc:pDesc,sum:0,count:0};
    pe.sum+=g.decimalValue; pe.count+=1; periodMap.set(pk,pe);
    const sId = Number.isFinite(g.subjectId)?g.subjectId:null;
    const sDesc = typeof g.subjectDesc==="string"&&g.subjectDesc.trim()?g.subjectDesc.trim():"Materia sconosciuta";
    const sk = `${sId??"none"}|${sDesc}`;
    const se = subjectMap.get(sk)||{subjectId:sId,subjectDesc:sDesc,sum:0,count:0};
    se.sum+=g.decimalValue; se.count+=1; subjectMap.set(sk,se);
  }
  return {
    total: { count: valid.length, average: compute(totalSum,valid.length) },
    byPeriod: [...periodMap.values()]
      .map(e => ({periodPos:e.periodPos,periodDesc:e.periodDesc,count:e.count,average:compute(e.sum,e.count)}))
      .sort((a,b) => { const ap=a.periodPos??Number.MAX_SAFE_INTEGER, bp=b.periodPos??Number.MAX_SAFE_INTEGER; return ap!==bp?ap-bp:a.periodDesc.localeCompare(b.periodDesc); }),
    bySubject: [...subjectMap.values()]
      .map(e => ({subjectId:e.subjectId,subjectDesc:e.subjectDesc,count:e.count,average:compute(e.sum,e.count)}))
      .sort((a,b) => a.subjectDesc.localeCompare(b.subjectDesc))
  };
};

// ─── CheMediaHo core
const buildGradesAvr = (grades, {includeBlueGrades=DEFAULT_BLUE}={}) => {
  const avr = {};
  for (const g of grades||[]) {
    const v = toNum(g?.decimalValue);
    if (v===null || g?.canceled===true || (!includeBlueGrades && isBlue(g))) continue;
    const period = toPeriod(g);
    const subject = findFirst(g.subjectDesc)||"Materia sconosciuta";
    (avr[period]??={});
    (avr[period][subject]??={count:0,avr:0,grades:[]});
    const sd = avr[period][subject];
    sd.count+=1;
    sd.grades.push({
      decimalValue: v,
      displayValue: findFirst(g.displayValue)||String(v),
      evtDate: findFirst(g.evtDate)||"",
      notesForFamily: findFirst(g.notesForFamily)||"",
      componentDesc: findFirst(g.componentDesc)||"",
      teacherName: findFirst(g.teacherName)||"",
      isBlue: isBlue(g)
    });
  }
  for (const [period, subjects] of Object.entries(avr)) {
    const periodGrades = [];
    for (const [subject, sd] of Object.entries(subjects)) {
      if (subject==="period_avr") continue;
      const eff = getEffectiveValid(sd.grades);
      sd.avr = avg(eff)||0;
      periodGrades.push(...eff);
    }
    avr[period].period_avr = avg(periodGrades)||0;
  }
  const all = [];
  for (const [period, subjects] of Object.entries(avr)) {
    if (period==="all_avr") continue;
    for (const [subject, sd] of Object.entries(subjects)) {
      if (subject==="period_avr") continue;
      all.push(...getEffectiveValid(sd.grades));
    }
  }
  avr.all_avr = avg(all)||0;
  return avr;
};

const getPeriodKeys = avr =>
  Object.keys(avr).filter(k=>k!=="all_avr").sort((a,b)=>Number(a)-Number(b));

const findSubjectKey = (periodData, name) => {
  const req = findFirst(name);
  if (!req || !periodData) return null;
  if (Object.prototype.hasOwnProperty.call(periodData, req)) return req;
  const lower = req.toLowerCase();
  return Object.keys(periodData).find(s=>s!=="period_avr"&&s.toLowerCase()===lower)||null;
};

const findSubjectAcross = (avr, name) => {
  for (const p of getPeriodKeys(avr)) {
    const k = findSubjectKey(avr[p]||{}, name);
    if (k && k!=="period_avr") return k;
  }
  return null;
};

const getAllEffective = avr => {
  const all = [];
  for (const p of getPeriodKeys(avr))
    for (const [s, sd] of Object.entries(avr[p]||{}))
      if (s!=="period_avr") all.push(...getEffectiveValid(sd.grades));
  return all;
};

const collectSubjectGrades = (avr, name) => {
  const req = findFirst(name);
  if (!req) return {subject:null,grades:[]};
  const lower = req.toLowerCase();
  const grades = []; let resolved = null;
  for (const p of getPeriodKeys(avr))
    for (const [s, sd] of Object.entries(avr[p]||{})) {
      if (s==="period_avr"||s.toLowerCase()!==lower) continue;
      if (!resolved) resolved = s;
      grades.push(...getEffectiveValid(sd.grades));
    }
  return {subject:resolved,grades};
};

const calcOptimal = (total, count, target) => {
  if (count>0 && total/count>=target) return [0,[]];
  let n = 1;
  if (target<G_MAX) {
    const d = G_MAX-target;
    if (d>0) n = Math.max(1, Math.floor((target*count-total)/d)+1);
  }
  n = Math.min(n, 5);
  let reqSum = target*(count+n)-total;
  let reqAvg = reqSum/n;
  while (reqAvg>G_MAX && n<MAX_GRADES) { n++; reqSum=target*(count+n)-total; reqAvg=reqSum/n; }
  return [n, Array.from({length:n},()=>Number(reqAvg.toFixed(1)))];
};

// ─── suggestion builders
const buildSuggestions = (gradesAvr, targetAvg, numGrades, allGrades, subjectsIter) => {
  const currentTotal = allGrades.reduce((a,b)=>a+b,0);
  const reqSum = targetAvg*(allGrades.length+numGrades)-currentTotal;
  const baseReq = reqSum/numGrades;
  const suggestions = [];
  for (const {subject, grades} of subjectsIter) {
    if (!grades.length) continue;
    const impact = (1/(grades.length+numGrades))*100;
    suggestions.push({
      subject,
      current_average: Number((grades.reduce((a,b)=>a+b,0)/grades.length).toFixed(2)),
      required_grade: roundToAllowed(baseReq),
      raw_required_grade: Number(baseReq.toFixed(2)),
      num_current_grades: grades.length,
      difficulty: Number((baseReq - impact*IMPACT_W).toFixed(2)),
      impact: Number(impact.toFixed(2)),
      is_achievable: baseReq<=G_MAX
    });
  }
  return suggestions
    .sort((a,b) => a.is_achievable!==b.is_achievable ? (a.is_achievable?-1:1) : a.difficulty-b.difficulty)
    .slice(0, MAX_SUGGESTIONS);
};

const calcPeriodSuggestions = (avr, period, targetAvg, numGrades) => {
  const pd = avr[period];
  if (!pd) return [];
  const subjects = Object.keys(pd).filter(s=>s!=="period_avr");
  const allGrades = subjects.flatMap(s=>getEffectiveValid(pd[s].grades));
  if (!allGrades.length || allGrades.reduce((a,b)=>a+b,0)/allGrades.length>=targetAvg) return [];
  return buildSuggestions(avr, targetAvg, numGrades, allGrades,
    subjects.map(s=>({subject:s, grades:getEffectiveValid(pd[s].grades)})));
};

const calcOverallSuggestions = (avr, targetAvg, numGrades) => {
  const allGrades = getAllEffective(avr);
  if (!allGrades.length) return [];
  const subjectsMap = new Map();
  for (const p of getPeriodKeys(avr))
    for (const [s, sd] of Object.entries(avr[p]||{})) {
      if (s==="period_avr") continue;
      const key = s.toLowerCase();
      const e = subjectsMap.get(key)||{subject:s,grades:[]};
      e.grades.push(...getEffectiveValid(sd.grades));
      subjectsMap.set(key,e);
    }
  return buildSuggestions(avr, targetAvg, numGrades, allGrades, subjectsMap.values());
};

// ─── message builders
const gradeText = n => n===1 ? "un voto" : `${n} voti`;

const goalMsg = (rawReq, displayGrade, target, current, n) => {
  const gt = gradeText(n);
  if (current>=target) return `Obiettivo gia raggiunto: media attuale ${current.toFixed(2)}.`;
  if (rawReq<G_MIN) return `Sei gia sopra l'obiettivo: anche con voti bassi raggiungi ${target}.`;
  if (rawReq>G_MAX) return `Obiettivo difficile: con ${gt} non arrivi a ${target}.`;
  if (rawReq>=9) return `Serve molto impegno: punta ad almeno ${displayGrade} per ${gt}.`;
  if (rawReq>=7) return `Obiettivo fattibile: con ${gt} da ${displayGrade} puoi arrivare a ${target}.`;
  return `Obiettivo raggiungibile: con ${gt} da ${displayGrade} puoi arrivare a ${target}.`;
};

const predictMsg = (change, predicted, n) => {
  const gt = gradeText(n), pf = predicted.toFixed(2), cf = change.toFixed(2);
  if (change>0.5)  return `Ottimo: con ${gt} la media salirebbe a ${pf} (${cf}).`;
  if (change>0)    return `Bene: con ${gt} la media migliorerebbe a ${pf} (${cf}).`;
  if (change===0)  return `Con ${gt} la media resterebbe stabile a ${pf}.`;
  if (change>-0.5) return `Attenzione: con ${gt} la media scenderebbe a ${pf} (${cf}).`;
  return `Attenzione: con ${gt} la media scenderebbe sensibilmente a ${pf} (${cf}).`;
};

const periodSuggestMsg = (suggestions, target, n, period) => {
  if (!suggestions.length) return `Nessun suggerimento disponibile per il periodo ${period}.`;
  const top = suggestions[0];
  if (top.required_grade>G_MAX) return `Raggiungere ${target} nel periodo ${period} e molto difficile.`;
  return `Concentrati su ${top.subject}: servono ${gradeText(n)} da ${top.required_grade}.`;
};

const overallSuggestMsg = (suggestions, target, n) => {
  if (!suggestions.length) return "Nessuna materia disponibile per il calcolo.";
  const top = suggestions[0];
  if (top.required_grade>G_MAX) return `Raggiungere la media generale ${target} e molto difficile.`;
  return `Concentrati su ${top.subject}: servono ${gradeText(n)} da ${top.required_grade}.`;
};

const goalOverallMsg = (rawReq, displayGrade, target, current, n, subject) => {
  const gt = gradeText(n);
  if (current>=target) return `Obiettivo gia raggiunto: media generale ${current.toFixed(2)}.`;
  if (rawReq>G_MAX) return `Obiettivo difficile: ${gt} in ${subject} non bastano per arrivare a ${target}.`;
  if (rawReq>=9) return `Serve molto impegno: ${gt} da almeno ${displayGrade} in ${subject}.`;
  return `Obiettivo fattibile: ${gt} da ${displayGrade} in ${subject}.`;
};

const predictOverallMsg = (change, predicted, n, subject) => {
  const gt = gradeText(n), pf = predicted.toFixed(2);
  if (change>0.5)  return `Ottimo: con ${gt} in ${subject} la media generale salirebbe a ${pf}.`;
  if (change>0)    return `Bene: con ${gt} in ${subject} la media generale migliorerebbe a ${pf}.`;
  if (change===0)  return `Con ${gt} in ${subject} la media generale resterebbe stabile a ${pf}.`;
  if (change>-0.5) return `Attenzione: con ${gt} in ${subject} la media generale scenderebbe a ${pf}.`;
  return `Attenzione: con ${gt} in ${subject} la media generale scenderebbe sensibilmente a ${pf}.`;
};

// ─── CSV export 
const buildCsv = avr => {
  const rows = [["Periodo","Materia","Voto","Data","Tipo","Docente","Note"]];
  for (const p of getPeriodKeys(avr)) {
    const pd = avr[p]||{};
    for (const subject of Object.keys(pd).filter(s=>s!=="period_avr").sort((a,b)=>a.localeCompare(b)))
      for (const g of pd[subject].grades||[])
        rows.push([`Periodo ${p}`,subject,g.decimalValue,g.evtDate||"",g.componentDesc||"",g.teacherName||"",g.notesForFamily||""]);
  }
  return rows.map(r=>r.map(csvEscape).join(",")).join("\n");
};

// ─── error util 
const toError = err => {
  if (axios.isAxiosError(err))
    return {message:err.message, status:err.response?.status||502, remote:err.response?.data||null};
  if (err&&typeof err==="object"&&"status" in err)
    return {message:err.message||"Unexpected error", status:err.status||500, remote:err.remote||null};
  return {message:err?.message||"Unexpected error", status:500, remote:null};
};

// ─── Express setup
const app = express();
const sessions = new Map();
const multipartParser = multer();

const corsAllowedOrigins = (
  process.env.CORS_ALLOWED_ORIGINS||"http://localhost:3000,https://media.gabrx.eu.org"
).split(",").map(o=>o.trim()).filter(Boolean);

const corsAllowedPatterns = [
  /^https:\/\/.*\.vercel\.app$/,
  /^https?:\/\/localhost(?::\d+)?$/,
  /^https?:\/\/127\.0\.0\.1(?::\d+)?$/
];

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || corsAllowedOrigins.includes(origin) || corsAllowedPatterns.some(p=>p.test(origin)))
      return cb(null,true);
    cb(null,false);
  },
  credentials: true,
  methods: ["GET","POST","PUT","PATCH","DELETE","OPTIONS"],
  allowedHeaders: ["Content-Type","Authorization","X-API-Key","x-session-id","x-uid","x-username","x-password","x-pass","x-ident"],
  exposedHeaders: ["Content-Type","x-session-id"],
  optionsSuccessStatus: 204
}));
app.options("*", cors());
app.use((req,_res,next) => req.is("multipart/form-data") ? multipartParser.none()(req,_res,next) : next());
app.use(express.json());
app.use(express.urlencoded({extended:true}));

// POST→GET rewrite
const postToGetPatterns = [
  /^\/api\/session$/,/^\/api\/card$/,/^\/api\/grades$/,/^\/api\/grades\/average$/,
  /^\/api\/chemediaho\/export$/,/^\/api\/chemediaho\/settings$/,
  /^\/api\/chemediaho\/overall_average_detail$/,
  /^\/api\/chemediaho\/subject_detail\/[^/]+$/,/^\/subject_detail\/[^/]+$/,
  /^\/api\/lessons$/,/^\/api\/absences$/,/^\/api\/agenda$/,/^\/api\/notes$/,
  /^\/api\/subjects$/,/^\/api\/periods$/,/^\/api\/noticeboard$/,
  /^\/api\/noticeboard\/download\/[^/]+(?:\/[^/]+)?$/,/^\/api\/calendar$/,
  /^\/api\/didactics$/,/^\/api\/documents$/,/^\/api\/documents\/status\/[^/]+$/,
  /^\/api\/documents\/read\/[^/]+$/,/^\/api\/documents\/download\/[^/]+$/,/^\/api\/overview$/
];
app.use((req,_,next) => { if (req.method==="POST"&&postToGetPatterns.some(p=>p.test(req.path))) req.method="GET"; next(); });

// Inject sessionId into every JSON response
app.use((req,res,next) => {
  const orig = res.json.bind(res);
  res.json = payload => {
    if (!req.localSessionId) return orig(payload);
    if (payload&&typeof payload==="object"&&!Array.isArray(payload)&&!Buffer.isBuffer(payload)) {
      if (payload.sessionId!==undefined) return orig(payload);
      return orig({sessionId:req.localSessionId,...payload});
    }
    return orig({sessionId:req.localSessionId,data:payload});
  };
  next();
});

// ─── middleware helpers ───────────────────────────────────────────────────────
const ah = fn => (req,res,next) => Promise.resolve(fn(req,res,next)).catch(next);

const extractCredentials = req => {
  const b = req.body&&typeof req.body==="object"?req.body:{};
  const q = req.query&&typeof req.query==="object"?req.query:{};
  const uid = findFirst(b.uid,b.username,b.user_id,b.user,q.uid,q.username,q.user_id,q.user,req.header("x-uid"),req.header("x-username"),req.header("x-user-id"));
  const password = findFirst(b.password,b.pass,b.user_pass,q.password,q.pass,q.user_pass,req.header("x-password"),req.header("x-pass"),req.header("x-user-pass"));
  if (!uid||!password) return null;
  return {uid,password,ident:findFirst(b.ident,q.ident,req.header("x-ident"))||null};
};

const createSession = async ({uid,password,ident=null}) => {
  const client = new ClassevivaClient();
  const login = await client.login({uid,password,ident});
  if (!login?.token) { const e=new Error("ClasseViva login succeeded without token"); e.status=502; e.remote=login; throw e; }
  const studentId = toStudentId(login.ident)||toStudentId(uid);
  if (!studentId) { const e=new Error("Could not infer studentId from ident/uid"); e.status=422; e.remote={uid,ident:login.ident||null}; throw e; }
  const sessionId = uuidv4();
  const session = {token:login.token,uid,ident:login.ident||null,studentId,firstName:login.firstName||null,lastName:login.lastName||null,release:login.release||null,expire:login.expire||null,includeBlueGrades:DEFAULT_BLUE,createdAt:new Date().toISOString()};
  sessions.set(sessionId,session);
  return {sessionId,session,loginData:login};
};

const requireSession = ah(async (req,res,next) => {
  const sid = req.header("x-session-id");
  const existing = sid ? sessions.get(sid) : null;
  if (existing) { req.localSessionId=sid; req.localSession=existing; res.setHeader("x-session-id",sid); return next(); }
  const creds = extractCredentials(req);
  if (creds) {
    const c = await createSession(creds);
    req.localSessionId=c.sessionId; req.localSession=c.session; req.autoLogin=true;
    res.setHeader("x-session-id",c.sessionId); return next();
  }
  const hint = "Use a valid x-session-id or send username/password, uid/password or user_id/user_pass in body/query";
  res.status(401).json(sid ? {error:"Invalid or expired session",hint} : {error:"Missing session",hint});
});

const getClient = s => new ClassevivaClient(s.token);

const loadGradesAvr = async (session, opts={}) => {
  const includeBlueGrades = typeof opts.includeBlueGrades==="boolean" ? opts.includeBlueGrades : (typeof session?.includeBlueGrades==="boolean" ? session.includeBlueGrades : DEFAULT_BLUE);
  const client = getClient(session);
  const data = await client.grades(session.studentId);
  const grades = Array.isArray(data?.grades)?data.grades:[];
  return {includeBlueGrades, grades, gradesAvr: buildGradesAvr(grades,{includeBlueGrades})};
};

// ─── routes ───────────────────────────────────────────────────────────────────
app.get("/api/health", (_,res) =>
  res.json({ok:true,service:"cvv-api",sessions:sessions.size,baseUrl:config.classevivaBaseUrl,version:config.version}));

app.post("/api/login", ah(async (req,res) => {
  const creds = extractCredentials(req);
  if (!creds) return res.status(400).json({error:"username/password, uid/password or user_id/user_pass are required"});
  const c = await createSession(creds);
  req.localSessionId=c.sessionId; req.localSession=c.session;
  res.setHeader("x-session-id",c.sessionId);
  res.json({sessionId:c.sessionId,studentId:c.session.studentId,profile:{uid:c.session.uid,ident:c.session.ident,firstName:c.session.firstName,lastName:c.session.lastName},token:{release:c.loginData.release||null,expire:c.loginData.expire||null}});
}));

app.post("/api/logout", requireSession, ah(async (req,res) => { sessions.delete(req.localSessionId); res.json({ok:true}); }));
app.post("/api/chemediaho/logout", requireSession, ah(async (req,res) => { sessions.delete(req.localSessionId); res.json({success:true,ok:true}); }));
app.get("/api/chemediaho/export", requireSession, ah(async (_req,res) => res.json({authenticated:true})));
app.get("/api/chemediaho/settings", (_,res) => res.json({version:config.version}));

app.get("/api/chemediaho/overall_average_detail", requireSession, ah(async (req,res) => {
  const {includeBlueGrades,gradesAvr} = await loadGradesAvr(req.localSession);
  res.json({include_blue_grades:includeBlueGrades,...gradesAvr});
}));

const subjectDetailHandler = ah(async (req,res) => {
  const requestedSubject = findFirst(req.params.subjectName, req.params.subject_name);
  if (!requestedSubject) return res.status(404).json({error:"Subject not found"});
  const {includeBlueGrades,gradesAvr} = await loadGradesAvr(req.localSession);
  const subjectName = findSubjectAcross(gradesAvr,requestedSubject);
  if (!subjectName) return res.status(404).json({error:"Subject not found"});
  res.json({include_blue_grades:includeBlueGrades,grades_avr:gradesAvr,subject_name:subjectName});
});
app.get("/api/chemediaho/subject_detail/:subjectName", requireSession, subjectDetailHandler);
app.get("/subject_detail/:subjectName", requireSession, subjectDetailHandler);

app.post("/api/chemediaho/set_blue_grade_preference", requireSession, ah(async (req,res) => {
  const includeBlueGrades = parseBool((req.body||{}).include_blue_grades, DEFAULT_BLUE);
  req.localSession.includeBlueGrades = includeBlueGrades;
  sessions.set(req.localSessionId, req.localSession);
  const {gradesAvr} = await loadGradesAvr(req.localSession,{includeBlueGrades});
  res.json({success:true,include_blue_grades:includeBlueGrades,all_avr:gradesAvr.all_avr});
}));

app.post("/api/chemediaho/calculate_goal", requireSession, ah(async (req,res) => {
  const p = req.body||{};
  const period = findFirst(p.period);
  const subject = findFirst(p.subject);
  const targetAvg = toNum(p.target_average);
  const numGrades = p.num_grades==null ? 1 : Math.trunc(toNum(p.num_grades));

  if (!period) return res.status(400).json({error:"Periodo non trovato"});
  if (targetAvg===null||targetAvg<G_MIN||targetAvg>G_MAX) return res.status(400).json({error:"La media target deve essere tra 1 e 10"});
  if (!Number.isInteger(numGrades)||numGrades<1||numGrades>MAX_GRADES) return res.status(400).json({error:"Il numero di voti deve essere tra 1 e 10"});

  const {gradesAvr} = await loadGradesAvr(req.localSession);
  const pd = gradesAvr[period];
  if (!pd||typeof pd!=="object") return res.status(400).json({error:"Periodo non trovato"});

  if (!subject) {
    const suggestions = calcPeriodSuggestions(gradesAvr,period,targetAvg,numGrades);
    return res.json({success:true,period,target_average:targetAvg,suggestions,num_grades:numGrades,message:periodSuggestMsg(suggestions,targetAvg,numGrades,period)});
  }

  const key = findSubjectKey(pd,subject);
  if (!key||key==="period_avr") return res.status(400).json({error:"Materia non trovata nel periodo selezionato"});

  const curGrades = getEffectiveValid(pd[key].grades);
  if (!curGrades.length) return res.status(400).json({error:"Nessun voto disponibile per questa materia"});

  const curSum = curGrades.reduce((a,b)=>a+b,0);
  const curAvg = toNum(pd[key].avr)||(curGrades.length?curSum/curGrades.length:0);

  if (curAvg>=targetAvg)
    return res.json({success:true,current_average:Number(curAvg.toFixed(2)),target_average:targetAvg,required_grade:null,required_grades:[],current_grades_count:curGrades.length,achievable:true,already_achieved:true,subject:key,message:`Obiettivo gia raggiunto: media attuale ${curAvg.toFixed(2)}.`});

  const rawReq = (targetAvg*(curGrades.length+numGrades)-curSum)/numGrades;
  const displayGrade = roundToAllowed(rawReq);
  return res.json({success:true,current_average:Number(curAvg.toFixed(2)),target_average:targetAvg,required_grade:displayGrade,required_grades:Array.from({length:numGrades},()=>displayGrade),current_grades_count:curGrades.length,achievable:rawReq>=G_MIN&&rawReq<=G_MAX,already_achieved:false,subject:key,message:goalMsg(rawReq,displayGrade,targetAvg,curAvg,numGrades)});
}));

app.post("/api/chemediaho/predict_average", requireSession, ah(async (req,res) => {
  const p = req.body||{};
  const period = findFirst(p.period), subject = findFirst(p.subject);
  const pg = Array.isArray(p.predicted_grades)?p.predicted_grades:[];
  if (!period||!subject) return res.status(400).json({error:"Materia o periodo non trovato"});
  if (!pg.length) return res.status(400).json({error:"Inserisci almeno un voto previsto"});
  const norm = pg.map(toNum);
  if (norm.some(v=>v===null||v<G_MIN||v>G_MAX)) return res.status(400).json({error:"Tutti i voti devono essere tra 1 e 10"});
  const {gradesAvr} = await loadGradesAvr(req.localSession);
  const pd = gradesAvr[period];
  const key = findSubjectKey(pd,subject);
  if (!pd||!key||key==="period_avr") return res.status(400).json({error:"Materia o periodo non trovato"});
  const cur = getEffectiveValid(pd[key].grades);
  if (!cur.length) return res.status(400).json({error:"Nessun voto disponibile per questa materia"});
  const curAvg = toNum(pd[key].avr)||cur.reduce((a,b)=>a+b,0)/cur.length;
  const predictedAvg = [...cur,...norm].reduce((a,b)=>a+b,0)/(cur.length+norm.length);
  const change = predictedAvg-curAvg;
  res.json({success:true,current_average:Number(curAvg.toFixed(2)),predicted_average:Number(predictedAvg.toFixed(2)),change:Number(change.toFixed(2)),num_predicted_grades:norm.length,message:predictMsg(change,predictedAvg,norm.length)});
}));

app.post("/api/chemediaho/calculate_goal_overall", requireSession, ah(async (req,res) => {
  const p = req.body||{};
  const subject = findFirst(p.subject);
  const targetAvg = toNum(p.target_average);
  if (targetAvg===null||targetAvg<G_MIN||targetAvg>G_MAX) return res.status(400).json({error:"La media target deve essere tra 1 e 10"});

  const {gradesAvr} = await loadGradesAvr(req.localSession);
  const curOverall = toNum(gradesAvr.all_avr)||0;

  if (curOverall>=targetAvg)
    return res.json({success:true,current_overall_average:Number(curOverall.toFixed(2)),target_average:targetAvg,suggestions:[],num_grades:0,auto_calculated:true,already_achieved:true,message:`Obiettivo gia raggiunto: media generale ${curOverall.toFixed(2)}.`});

  const allGrades = getAllEffective(gradesAvr);
  if (!allGrades.length) return res.status(400).json({error:"Nessun voto disponibile"});

  const curTotal = allGrades.reduce((a,b)=>a+b,0);
  const autoCalc = p.num_grades==null;
  let numGrades = autoCalc ? calcOptimal(curTotal,allGrades.length,targetAvg)[0] : Math.trunc(toNum(p.num_grades));
  if (!Number.isInteger(numGrades)||numGrades<1||numGrades>MAX_GRADES) return res.status(400).json({error:"Il numero di voti deve essere tra 1 e 10"});

  if (!subject) {
    const suggestions = calcOverallSuggestions(gradesAvr,targetAvg,numGrades);
    return res.json({success:true,current_overall_average:Number(curOverall.toFixed(2)),target_average:targetAvg,suggestions,num_grades:numGrades,auto_calculated:autoCalc,message:overallSuggestMsg(suggestions,targetAvg,numGrades)});
  }

  const sd = collectSubjectGrades(gradesAvr,subject);
  if (!sd.subject||!sd.grades.length) return res.status(400).json({error:"Materia non trovata"});

  const rawReq = (targetAvg*(allGrades.length+numGrades)-curTotal)/numGrades;
  const displayGrade = roundToAllowed(rawReq);
  res.json({success:true,current_overall_average:Number(curOverall.toFixed(2)),target_average:targetAvg,required_grade:displayGrade,required_grades:Array.from({length:numGrades},()=>displayGrade),current_grades_count:allGrades.length,achievable:rawReq>=G_MIN&&rawReq<=G_MAX,subject:sd.subject,message:goalOverallMsg(rawReq,displayGrade,targetAvg,curOverall,numGrades,sd.subject)});
}));

app.post("/api/chemediaho/predict_average_overall", requireSession, ah(async (req,res) => {
  const p = req.body||{};
  const period = findFirst(p.period), subject = findFirst(p.subject);
  const pg = Array.isArray(p.predicted_grades)?p.predicted_grades:[];
  if (!period||!subject) return res.status(400).json({error:"Materia o periodo non trovato"});
  if (!pg.length) return res.status(400).json({error:"Inserisci almeno un voto previsto"});
  const norm = pg.map(toNum);
  if (norm.some(v=>v===null||v<G_MIN||v>G_MAX)) return res.status(400).json({error:"Tutti i voti devono essere tra 1 e 10"});
  const {gradesAvr} = await loadGradesAvr(req.localSession);
  const pd = gradesAvr[period];
  const key = findSubjectKey(pd,subject);
  if (!pd||!key||key==="period_avr") return res.status(400).json({error:"Materia o periodo non trovato"});
  const allGrades = getAllEffective(gradesAvr);
  if (!allGrades.length) return res.status(400).json({error:"Nessun voto disponibile"});
  const curOverall = toNum(gradesAvr.all_avr)||0;
  const predictedOverall = [...allGrades,...norm].reduce((a,b)=>a+b,0)/(allGrades.length+norm.length);
  const change = predictedOverall-curOverall;
  res.json({success:true,current_overall_average:Number(curOverall.toFixed(2)),predicted_overall_average:Number(predictedOverall.toFixed(2)),change:Number(change.toFixed(2)),num_predicted_grades:norm.length,subject:key,period,message:predictOverallMsg(change,predictedOverall,norm.length,key)});
}));

app.post("/api/chemediaho/export/csv", requireSession, ah(async (req,res) => {
  const {gradesAvr} = await loadGradesAvr(req.localSession);
  const fileName = `voti_${nowTimestamp()}.csv`;
  res.setHeader("Content-Type","text/csv; charset=utf-8");
  res.setHeader("Content-Disposition",`attachment; filename="${fileName}"`);
  res.send(buildCsv(gradesAvr));
}));

app.get("/api/session", requireSession, ah(async (req,res) => {
  const status = await getClient(req.localSession).authStatus();
  res.json({localSessionId:req.localSessionId,localSession:{studentId:req.localSession.studentId,ident:req.localSession.ident,firstName:req.localSession.firstName,lastName:req.localSession.lastName,createdAt:req.localSession.createdAt},remote:status});
}));

app.get("/api/card", requireSession, ah(async (req,res) => {
  res.json(await getClient(req.localSession).studentCard(req.localSession.studentId));
}));

app.get("/api/grades", requireSession, ah(async (req,res) => {
  const data = await getClient(req.localSession).grades(req.localSession.studentId);
  const grades = data.grades||[];
  res.json({summary:buildGradesSummary(grades),grades});
}));

app.get("/api/grades/average", requireSession, ah(async (req,res) => {
  const data = await getClient(req.localSession).grades(req.localSession.studentId);
  res.json(buildGradesAverages(data.grades||[]));
}));

app.get("/api/lessons", requireSession, ah(async (req,res) => {
  const {day,start,end} = req.query;
  const client = getClient(req.localSession);
  const sid = req.localSession.studentId;
  const data = start&&end ? await client.lessonsByRange(sid,start,end)
    : day ? await client.lessonsByDay(sid,day)
    : await client.lessonsToday(sid);
  res.json({count:(data.lessons||[]).length,lessons:data.lessons||[]});
}));

app.get("/api/absences", requireSession, ah(async (req,res) => {
  const {begin,end} = req.query;
  const client = getClient(req.localSession);
  const sid = req.localSession.studentId;
  const data = begin&&end ? await client.absencesRange(sid,begin,end)
    : begin ? await client.absencesFrom(sid,begin)
    : await client.absences(sid);
  res.json({count:(data.events||[]).length,events:data.events||[]});
}));

app.get("/api/agenda", requireSession, ah(async (req,res) => {
  const {eventCode} = req.query;
  const range = withDefaultRange(req.query.begin,req.query.end);
  const client = getClient(req.localSession);
  const sid = req.localSession.studentId;
  const data = eventCode
    ? await client.agendaByEventCode(sid,eventCode,range.begin,range.end)
    : await client.agenda(sid,range.begin,range.end);
  res.json({begin:range.begin,end:range.end,eventCode:eventCode||"all",count:(data.agenda||[]).length,agenda:data.agenda||[]});
}));

app.get("/api/notes", requireSession, ah(async (req,res) => {
  const grouped = await getClient(req.localSession).notes(req.localSession.studentId);
  const flat = flattenNotesGroups(grouped);
  res.json({total:flat.length,grouped,notes:flat});
}));

app.post("/api/notes/read", requireSession, ah(async (req,res) => {
  const {type,noteId} = req.body||{};
  if (!type||!noteId) return res.status(400).json({error:"type and noteId are required"});
  res.json(await getClient(req.localSession).readNote(req.localSession.studentId,type,noteId));
}));

app.get("/api/subjects", requireSession, ah(async (req,res) => {
  const data = await getClient(req.localSession).subjects(req.localSession.studentId);
  res.json({count:(data.subjects||[]).length,subjects:data.subjects||[]});
}));

app.get("/api/periods", requireSession, ah(async (req,res) => {
  res.json(await getClient(req.localSession).periods(req.localSession.studentId));
}));

app.get("/api/noticeboard", requireSession, ah(async (req,res) => {
  const client = getClient(req.localSession);
  const data = await client.noticeboard(req.localSession.studentId);
  const base = `${req.protocol}://${req.get("host")}`;
  const items = (data.items||[]).map(item => {
    const ec = findFirst(item.evtCode)||"CF";
    const attachments = (item.attachments||[]).map(a => ({
      ...a,
      downloadUrl:`${base}/api/noticeboard/download/${encodeURIComponent(item.pubId)}/${encodeURIComponent(a.attachNum)}?eventCode=${encodeURIComponent(ec)}`
    }));
    return {...item,attachments,defaultDownloadUrl:attachments.length>0?attachments[0].downloadUrl:`${base}/api/noticeboard/download/${encodeURIComponent(item.pubId)}?eventCode=${encodeURIComponent(ec)}`};
  });
  res.json({count:items.length,items});
}));

app.get("/api/noticeboard/download/:pubId/:attachNum?", requireSession, ah(async (req,res) => {
  const client = getClient(req.localSession);
  const sid = req.localSession.studentId;
  const pubId = String(req.params.pubId);
  const reqEC = findFirst(req.query.eventCode,req.body?.eventCode);
  const reqAN = findFirst(req.params.attachNum,req.query.attachNum,req.body?.attachNum);
  const nb = await client.noticeboard(sid);
  const item = (nb.items||[]).find(i=>String(i.pubId)===pubId);
  if (!item&&!reqEC) return res.status(404).json({error:"Noticeboard item not found",hint:"Provide a valid pubId or pass eventCode explicitly"});
  const ec = reqEC||findFirst(item?.evtCode)||"CF";
  const attachments = item?.attachments||[];
  const attachNum = reqAN||(attachments.length>0?String(attachments[0].attachNum):"101");
  const matched = attachments.find(a=>String(a.attachNum)===String(attachNum));
  const fileName = sanitizeFilename(findFirst(req.query.filename,req.body?.filename),matched?.fileName||`circolare_${pubId}_${attachNum}.pdf`);
  const attachment = await client.noticeboardAttachment(sid,ec,pubId,attachNum);
  res.setHeader("Content-Type",attachment.contentType);
  res.setHeader("Content-Disposition",`attachment; filename="${fileName}"`);
  res.send(Buffer.from(attachment.data));
}));

app.get("/api/calendar", requireSession, ah(async (req,res) => {
  const data = await getClient(req.localSession).calendar(req.localSession.studentId);
  res.json({count:(data.calendar||[]).length,calendar:data.calendar||[]});
}));

app.get("/api/didactics", requireSession, ah(async (req,res) => {
  res.json(await getClient(req.localSession).didactics(req.localSession.studentId));
}));

app.get("/api/documents", requireSession, ah(async (req,res) => {
  const client = getClient(req.localSession);
  const data = await client.documents(req.localSession.studentId);
  const base = `${req.protocol}://${req.get("host")}`;
  res.json({...data,documents:(data.documents||[]).map(d=>({...d,readUrl:`${base}/api/documents/read/${encodeURIComponent(d.hash)}`,downloadUrl:`${base}/api/documents/download/${encodeURIComponent(d.hash)}`}))});
}));

app.get("/api/documents/status/:hash", requireSession, ah(async (req,res) => {
  res.json(await getClient(req.localSession).documentStatus(req.localSession.studentId,req.params.hash));
}));

const serveDocument = (download) => ah(async (req,res) => {
  const doc = await getClient(req.localSession).readDocument(req.localSession.studentId,req.params.hash);
  const forceDownload = download || ["1","true","yes"].includes(String(req.query.download||"").toLowerCase());
  if (forceDownload) {
    const fn = sanitizeFilename(req.query.filename,`${req.params.hash}.pdf`);
    res.setHeader("Content-Disposition",`attachment; filename="${fn}"`);
  }
  res.setHeader("Content-Type",doc.contentType);
  res.send(Buffer.from(doc.data));
});
app.get("/api/documents/read/:hash", requireSession, serveDocument(false));
app.get("/api/documents/download/:hash", requireSession, serveDocument(true));

app.post("/api/raw", requireSession, ah(async (req,res) => {
  const {method="GET",path,data} = req.body||{};
  const np = !path||typeof path!=="string" ? null : (path.startsWith("/")?path:`/${path}`);
  const normPath = np?.startsWith("/v1/")?np:null;
  if (!normPath) return res.status(400).json({error:"Invalid path. Use a path starting with /v1/"});
  const m = String(method).toUpperCase();
  if (m!=="GET"&&m!=="POST") return res.status(400).json({error:"Only GET and POST are supported"});
  const client = getClient(req.localSession);
  const result = m==="GET" ? await client.get(normPath) : await client.post(normPath,data);
  res.json({method:m,path:normPath,data:result});
}));

app.get("/api/overview", requireSession, ah(async (req,res) => {
  const client = getClient(req.localSession);
  const sid = req.localSession.studentId;
  const [card,grades,lessons,absences,notes] = await Promise.allSettled([
    client.studentCard(sid),client.grades(sid),client.lessonsToday(sid),client.absences(sid),client.notes(sid)
  ]);
  const mapR = r => r.status==="fulfilled" ? {ok:true,data:r.value} : {ok:false,error:toError(r.reason)};
  const notesVal = notes.status==="fulfilled"?notes.value:{};
  const flatNotes = flattenNotesGroups(notesVal);
  const gradesArr = grades.status==="fulfilled"?grades.value.grades||[]:[];
  res.json({studentId:sid,card:mapR(card),grades:{...mapR(grades),summary:buildGradesSummary(gradesArr)},lessons:mapR(lessons),absences:mapR(absences),notes:{...mapR(notes),total:flatNotes.length,latest:flatNotes.slice(0,5)}});
}));

app.use((err,req,res,_next) => { const e=toError(err); res.status(e.status).json({error:e.message,remote:e.remote}); });

app.listen(config.port, () => console.log(`cvv-api listening on http://localhost:${config.port}`));
