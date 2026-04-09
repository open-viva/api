import axios from "axios";
import { config } from "./config.js";

const getBaseHeaders = () => ({
  "Content-Type": "application/json",
  "ContentsDiary-Type": config.classevivaContentsDiaryType,
  "User-Agent": config.classevivaUserAgent,
  "Z-Dev-ApiKey": config.classevivaDevApiKey
});

export class ClassevivaClient {
  constructor(token = null) {
    this.token = token;
    this.http = axios.create({
      baseURL: config.classevivaBaseUrl,
      timeout: config.requestTimeoutMs
    });
  }

  setToken(token) {
    this.token = token;
  }

  headers() {
    const headers = getBaseHeaders();
    if (this.token) {
      headers["Z-Auth-Token"] = this.token;
    }
    return headers;
  }

  async login({ uid, password, ident = null }) {
    const body = {
      ident,
      pass: password,
      uid
    };

    const response = await this.http.post("/v1/auth/login", body, {
      headers: this.headers()
    });

    return response.data;
  }

  async authStatus() {
    return this.get("/v1/auth/status");
  }

  async studentCard(studentId) {
    return this.get(`/v1/students/${studentId}/card`);
  }

  async studentCards(studentId) {
    return this.get(`/v1/students/${studentId}/cards`);
  }

  async grades(studentId) {
    return this.get(`/v1/students/${studentId}/grades`);
  }

  async lessonsToday(studentId) {
    return this.get(`/v1/students/${studentId}/lessons/today`);
  }

  async lessonsByDay(studentId, day) {
    return this.get(`/v1/students/${studentId}/lessons/${day}`);
  }

  async lessonsByRange(studentId, start, end) {
    return this.get(`/v1/students/${studentId}/lessons/${start}/${end}`);
  }

  async absences(studentId) {
    return this.get(`/v1/students/${studentId}/absences/details`);
  }

  async absencesFrom(studentId, begin) {
    return this.get(`/v1/students/${studentId}/absences/details/${begin}`);
  }

  async absencesRange(studentId, begin, end) {
    return this.get(`/v1/students/${studentId}/absences/details/${begin}/${end}`);
  }

  async agenda(studentId, begin, end) {
    return this.get(`/v1/students/${studentId}/agenda/all/${begin}/${end}`);
  }

  async agendaByEventCode(studentId, eventCode, begin, end) {
    return this.get(`/v1/students/${studentId}/agenda/${eventCode}/${begin}/${end}`);
  }

  async notes(studentId) {
    return this.get(`/v1/students/${studentId}/notes/all`);
  }

  async readNote(studentId, type, noteId) {
    return this.post(`/v1/students/${studentId}/notes/${type}/read/${noteId}`);
  }

  async periods(studentId) {
    return this.get(`/v1/students/${studentId}/periods`);
  }

  async subjects(studentId) {
    return this.get(`/v1/students/${studentId}/subjects`);
  }

  async noticeboard(studentId) {
    return this.get(`/v1/students/${studentId}/noticeboard`);
  }

  async didactics(studentId) {
    return this.get(`/v1/students/${studentId}/didactics`);
  }

  async calendar(studentId) {
    return this.get(`/v1/students/${studentId}/calendar/all`);
  }

  async documents(studentId) {
    return this.post(`/v1/students/${studentId}/documents`);
  }

  async documentStatus(studentId, hash) {
    return this.post(`/v1/students/${studentId}/documents/check/${hash}`);
  }

  async readDocument(studentId, hash) {
    const response = await this.http.post(
      `/v1/students/${studentId}/documents/read/${hash}`,
      undefined,
      {
        headers: this.headers(),
        responseType: "arraybuffer"
      }
    );

    return {
      data: response.data,
      contentType: response.headers["content-type"] || "application/octet-stream"
    };
  }

  async get(path) {
    const response = await this.http.get(path, { headers: this.headers() });
    return response.data;
  }

  async post(path, data = undefined) {
    const response = await this.http.post(path, data, { headers: this.headers() });
    return response.data;
  }
}
