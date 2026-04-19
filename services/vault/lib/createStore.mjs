import mysql from "mysql2/promise";

const nowIso = () => new Date().toISOString();
const randomToken = (prefix) => `${prefix}_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
const parseJsonColumn = (value, fallback = null) => {
  if (value == null) {
    return fallback;
  }
  if (typeof value === "string") {
    return JSON.parse(value);
  }
  return value;
};

const sortRavenTitles = (titles) => [...titles].sort((left, right) => String(left.title || "").localeCompare(String(right.title || "")));
const sortRavenChapters = (chapters) => [...chapters].sort((left, right) => {
  const leftNumber = Number.parseFloat(String(left.chapterNumber || "0"));
  const rightNumber = Number.parseFloat(String(right.chapterNumber || "0"));
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && leftNumber !== rightNumber) {
    return rightNumber - leftNumber;
  }
  return String(right.chapterNumber || right.label || "").localeCompare(String(left.chapterNumber || left.label || ""));
});
const normalizeRavenTitle = (title, chapters = []) => ({
  id: title.id,
  title: title.title,
  mediaType: title.mediaType || "manga",
  status: title.status || "active",
  latestChapter: title.latestChapter || "",
  coverAccent: title.coverAccent || "#4f8f88",
  summary: title.summary || "",
  releaseLabel: title.releaseLabel || "",
  chapterCount: Number.parseInt(String(title.chapterCount || 0), 10) || 0,
  chaptersDownloaded: Number.parseInt(String(title.chaptersDownloaded || 0), 10) || 0,
  author: title.author || "",
  tags: Array.isArray(title.tags) ? title.tags : [],
  aliases: Array.isArray(title.aliases) ? title.aliases : [],
  metadataProvider: title.metadataProvider || "",
  metadataMatchedAt: title.metadataMatchedAt || null,
  relations: Array.isArray(title.relations) ? title.relations : [],
  sourceUrl: title.sourceUrl || "",
  coverUrl: title.coverUrl || "",
  downloadRoot: title.downloadRoot || "",
  chapters: sortRavenChapters(chapters)
});

const defaultPermissionsForRole = (role) => {
  switch (role) {
    case "owner":
    case "admin":
      return ["admin", "manage_users", "manage_settings", "moderate_requests", "read_requests", "read_library", "read_ai_status"];
    case "moderator":
      return ["moderate_requests", "read_requests", "read_library", "read_ai_status"];
    default:
      return ["read_library", "create_requests", "read_requests", "read_ai_status"];
  }
};

const createMemoryStore = () => {
  const state = {
    users: new Map(),
    sessions: new Map(),
    settings: new Map(),
    secrets: new Map(),
    requests: new Map(),
    progress: new Map(),
    ravenTitles: new Map(),
    ravenChapters: new Map(),
    ravenDownloadTasks: new Map(),
    ravenMetadataMatches: new Map(),
    requestSeq: 1
  };

  return {
    driver: "memory",
    async init() {
      return true;
    },
    async health() {
      return {ready: true, degraded: true, reason: "Running with the in-memory development store."};
    },
    async getBootstrapStatus(superuserId) {
      const owner = Array.from(state.users.values()).find((user) => user.role === "owner");
      return {
        ownerClaimed: Boolean(owner),
        superuserIdConfigured: Boolean(superuserId),
        superuserId,
        ownerDiscordUserId: owner?.discordUserId || null
      };
    },
    async upsertDiscordUser({discordUserId, username, avatarUrl, role, permissions, claimOwner = false}) {
      const existing = state.users.get(discordUserId);
      const nextRole = role || existing?.role || (claimOwner ? "owner" : "member");
      const next = {
        id: discordUserId,
        discordUserId,
        username,
        avatarUrl: avatarUrl || null,
        role: nextRole,
        permissions: permissions?.length ? permissions : defaultPermissionsForRole(nextRole),
        createdAt: existing?.createdAt || nowIso(),
        updatedAt: nowIso()
      };
      state.users.set(discordUserId, next);
      return next;
    },
    async getUserByDiscordId(discordUserId) {
      return state.users.get(discordUserId) || null;
    },
    async listUsers() {
      return Array.from(state.users.values()).sort((left, right) => left.username.localeCompare(right.username));
    },
    async createSession({discordUserId}) {
      const token = randomToken("sess");
      const session = {
        token,
        discordUserId,
        createdAt: nowIso()
      };
      state.sessions.set(token, session);
      return session;
    },
    async getSession(token) {
      return state.sessions.get(token) || null;
    },
    async getUserForSession(token) {
      const session = await this.getSession(token);
      if (!session) {
        return null;
      }
      return this.getUserByDiscordId(session.discordUserId);
    },
    async setSetting(key, value) {
      state.settings.set(key, {key, value, updatedAt: nowIso()});
      return state.settings.get(key);
    },
    async getSetting(key) {
      return state.settings.get(key) || null;
    },
    async setSecret(key, value) {
      state.secrets.set(key, {key, value, updatedAt: nowIso()});
      return state.secrets.get(key);
    },
    async getSecret(key) {
      return state.secrets.get(key) || null;
    },
    async listRequests() {
      return Array.from(state.requests.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    async createRequest(payload) {
      const id = state.requestSeq++;
      const request = {
        id,
        status: "pending",
        timeline: [
          {
            type: "created",
            message: "Request created.",
            at: nowIso(),
            actor: payload.requestedBy
          }
        ],
        ...payload,
        createdAt: nowIso(),
        updatedAt: nowIso()
      };
      state.requests.set(id, request);
      return request;
    },
    async reviewRequest(id, review) {
      const existing = state.requests.get(Number(id));
      if (!existing) {
        return null;
      }
      existing.status = review.status;
      existing.moderatorComment = review.comment || "";
      existing.updatedAt = nowIso();
      existing.timeline.push({
        type: review.status,
        message: review.comment || `Request ${review.status}.`,
        at: nowIso(),
        actor: review.actor
      });
      return existing;
    },
    async upsertProgress(entry) {
      state.progress.set(entry.mediaId, {
        ...entry,
        updatedAt: nowIso()
      });
      return state.progress.get(entry.mediaId);
    },
    async getProgressByUser(discordUserId) {
      return Array.from(state.progress.values()).filter((entry) => entry.discordUserId === discordUserId);
    },
    async listRavenTitles() {
      return sortRavenTitles(Array.from(state.ravenTitles.values()).map((title) =>
        normalizeRavenTitle(title, Array.from((state.ravenChapters.get(title.id) || new Map()).values()))
      ));
    },
    async getRavenTitle(titleId) {
      const title = state.ravenTitles.get(titleId);
      if (!title) {
        return null;
      }
      return normalizeRavenTitle(title, Array.from((state.ravenChapters.get(titleId) || new Map()).values()));
    },
    async upsertRavenTitle(title) {
      const existing = state.ravenTitles.get(title.id) || {};
      state.ravenTitles.set(title.id, {
        ...existing,
        ...normalizeRavenTitle(title, existing.chapters || []),
        updatedAt: nowIso()
      });
      return this.getRavenTitle(title.id);
    },
    async replaceRavenChapters(titleId, chapters) {
      state.ravenChapters.set(titleId, new Map(sortRavenChapters(chapters).map((chapter) => [chapter.id, {
        ...chapter,
        updatedAt: nowIso()
      }])));
      return Array.from(state.ravenChapters.get(titleId).values());
    },
    async listRavenDownloadTasks() {
      return Array.from(state.ravenDownloadTasks.values()).sort((left, right) =>
        String(right.queuedAt || right.updatedAt || "").localeCompare(String(left.queuedAt || left.updatedAt || ""))
      );
    },
    async upsertRavenDownloadTask(task) {
      state.ravenDownloadTasks.set(task.taskId, {
        ...(state.ravenDownloadTasks.get(task.taskId) || {}),
        ...task,
        updatedAt: nowIso()
      });
      return state.ravenDownloadTasks.get(task.taskId);
    },
    async getRavenMetadataMatch(titleId) {
      return state.ravenMetadataMatches.get(titleId) || null;
    },
    async setRavenMetadataMatch(titleId, value) {
      const entry = {
        titleId,
        ...value,
        updatedAt: nowIso()
      };
      state.ravenMetadataMatches.set(titleId, entry);
      return entry;
    }
  };
};

const createMysqlStore = (config) => {
  const pool = mysql.createPool({
    host: config.mysql.host,
    port: config.mysql.port,
    user: config.mysql.user,
    password: config.mysql.password,
    database: config.mysql.database,
    connectionLimit: 5
  });

  const init = async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        discord_user_id VARCHAR(64) PRIMARY KEY,
        username VARCHAR(255) NOT NULL,
        avatar_url TEXT NULL,
        role_name VARCHAR(32) NOT NULL,
        permissions_json JSON NOT NULL,
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        token VARCHAR(128) PRIMARY KEY,
        discord_user_id VARCHAR(64) NOT NULL,
        created_at DATETIME NOT NULL
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS settings (
        setting_key VARCHAR(128) PRIMARY KEY,
        setting_value JSON NOT NULL,
        updated_at DATETIME NOT NULL
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS requests (
        id BIGINT PRIMARY KEY AUTO_INCREMENT,
        source VARCHAR(32) NOT NULL,
        title VARCHAR(255) NOT NULL,
        request_type VARCHAR(32) NOT NULL,
        notes TEXT NULL,
        requested_by VARCHAR(64) NOT NULL,
        status_name VARCHAR(32) NOT NULL,
        moderator_comment TEXT NULL,
        timeline_json JSON NOT NULL,
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS media_progress (
        media_id VARCHAR(128) NOT NULL,
        discord_user_id VARCHAR(64) NOT NULL,
        chapter_label VARCHAR(128) NOT NULL,
        position_ratio DOUBLE NOT NULL,
        bookmark_json JSON NULL,
        updated_at DATETIME NOT NULL,
        PRIMARY KEY (media_id, discord_user_id)
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS secrets (
        secret_key VARCHAR(128) PRIMARY KEY,
        secret_value JSON NOT NULL,
        updated_at DATETIME NOT NULL
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS raven_titles (
        title_id VARCHAR(191) PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        media_type VARCHAR(64) NOT NULL,
        status_name VARCHAR(64) NOT NULL,
        latest_chapter VARCHAR(64) NULL,
        cover_accent VARCHAR(32) NULL,
        summary TEXT NULL,
        release_label VARCHAR(64) NULL,
        chapter_count INT NOT NULL DEFAULT 0,
        chapters_downloaded INT NOT NULL DEFAULT 0,
        author_name VARCHAR(255) NULL,
        tags_json JSON NOT NULL,
        aliases_json JSON NOT NULL,
        relations_json JSON NOT NULL,
        metadata_provider VARCHAR(64) NULL,
        metadata_matched_at DATETIME NULL,
        source_url TEXT NULL,
        cover_url TEXT NULL,
        download_root TEXT NULL,
        updated_at DATETIME NOT NULL
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS raven_chapters (
        title_id VARCHAR(191) NOT NULL,
        chapter_id VARCHAR(191) NOT NULL,
        label_name VARCHAR(255) NOT NULL,
        chapter_number VARCHAR(64) NULL,
        page_count INT NOT NULL DEFAULT 0,
        release_date VARCHAR(64) NULL,
        is_available TINYINT(1) NOT NULL DEFAULT 1,
        archive_path TEXT NULL,
        source_url TEXT NULL,
        updated_at DATETIME NOT NULL,
        PRIMARY KEY (title_id, chapter_id)
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS raven_download_tasks (
        task_id VARCHAR(191) PRIMARY KEY,
        title_id VARCHAR(191) NULL,
        title_name VARCHAR(255) NOT NULL,
        title_url TEXT NOT NULL,
        request_type VARCHAR(64) NOT NULL,
        requested_by VARCHAR(64) NOT NULL,
        status_name VARCHAR(64) NOT NULL,
        message_text TEXT NULL,
        percent_value INT NOT NULL DEFAULT 0,
        queued_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS raven_metadata_matches (
        title_id VARCHAR(191) PRIMARY KEY,
        provider_id VARCHAR(64) NOT NULL,
        provider_series_id VARCHAR(191) NOT NULL,
        details_json JSON NOT NULL,
        updated_at DATETIME NOT NULL
      )
    `);
  };

  const toUser = (row) => ({
    id: row.discord_user_id,
    discordUserId: row.discord_user_id,
    username: row.username,
    avatarUrl: row.avatar_url,
    role: row.role_name,
    permissions: parseJsonColumn(row.permissions_json, []),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  });
  const toRavenChapter = (row) => ({
    id: row.chapter_id,
    label: row.label_name,
    chapterNumber: row.chapter_number,
    pageCount: row.page_count,
    releaseDate: row.release_date,
    available: row.is_available === 1,
    archivePath: row.archive_path,
    sourceUrl: row.source_url,
    updatedAt: row.updated_at.toISOString()
  });
  const toRavenTitle = (row, chapters = []) => normalizeRavenTitle({
    id: row.title_id,
    title: row.title,
    mediaType: row.media_type,
    status: row.status_name,
    latestChapter: row.latest_chapter,
    coverAccent: row.cover_accent,
    summary: row.summary,
    releaseLabel: row.release_label,
    chapterCount: row.chapter_count,
    chaptersDownloaded: row.chapters_downloaded,
    author: row.author_name,
    tags: parseJsonColumn(row.tags_json, []),
    aliases: parseJsonColumn(row.aliases_json, []),
    metadataProvider: row.metadata_provider,
    metadataMatchedAt: row.metadata_matched_at ? row.metadata_matched_at.toISOString() : null,
    relations: parseJsonColumn(row.relations_json, []),
    sourceUrl: row.source_url,
    coverUrl: row.cover_url,
    downloadRoot: row.download_root
  }, chapters);

  return {
    driver: "mysql",
    init,
    async health() {
      await pool.query("SELECT 1");
      return {ready: true, degraded: false, reason: null};
    },
    async getBootstrapStatus(superuserId) {
      const [rows] = await pool.query("SELECT discord_user_id FROM users WHERE role_name = 'owner' LIMIT 1");
      return {
        ownerClaimed: rows.length > 0,
        superuserIdConfigured: Boolean(superuserId),
        superuserId,
        ownerDiscordUserId: rows[0]?.discord_user_id || null
      };
    },
    async upsertDiscordUser({discordUserId, username, avatarUrl, role, permissions, claimOwner = false}) {
      const [existingRows] = await pool.query("SELECT * FROM users WHERE discord_user_id = ?", [discordUserId]);
      const nextRole = role || existingRows[0]?.role_name || (claimOwner ? "owner" : "member");
      const nextPermissions = permissions?.length ? permissions : defaultPermissionsForRole(nextRole);
      await pool.query(`
        INSERT INTO users (discord_user_id, username, avatar_url, role_name, permissions_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, NOW(), NOW())
        ON DUPLICATE KEY UPDATE username = VALUES(username), avatar_url = VALUES(avatar_url), role_name = VALUES(role_name),
        permissions_json = VALUES(permissions_json), updated_at = NOW()
      `, [discordUserId, username, avatarUrl || null, nextRole, JSON.stringify(nextPermissions)]);
      return this.getUserByDiscordId(discordUserId);
    },
    async getUserByDiscordId(discordUserId) {
      const [rows] = await pool.query("SELECT * FROM users WHERE discord_user_id = ? LIMIT 1", [discordUserId]);
      return rows[0] ? toUser(rows[0]) : null;
    },
    async listUsers() {
      const [rows] = await pool.query("SELECT * FROM users ORDER BY username ASC");
      return rows.map(toUser);
    },
    async createSession({discordUserId}) {
      const token = randomToken("sess");
      await pool.query("INSERT INTO sessions (token, discord_user_id, created_at) VALUES (?, ?, NOW())", [token, discordUserId]);
      return {token, discordUserId};
    },
    async getSession(token) {
      const [rows] = await pool.query("SELECT * FROM sessions WHERE token = ? LIMIT 1", [token]);
      return rows[0]
        ? {token: rows[0].token, discordUserId: rows[0].discord_user_id, createdAt: rows[0].created_at.toISOString()}
        : null;
    },
    async getUserForSession(token) {
      const session = await this.getSession(token);
      if (!session) {
        return null;
      }
      return this.getUserByDiscordId(session.discordUserId);
    },
    async setSetting(key, value) {
      await pool.query(`
        INSERT INTO settings (setting_key, setting_value, updated_at)
        VALUES (?, ?, NOW())
        ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_at = NOW()
      `, [key, JSON.stringify(value)]);
      return this.getSetting(key);
    },
    async getSetting(key) {
      const [rows] = await pool.query("SELECT * FROM settings WHERE setting_key = ? LIMIT 1", [key]);
      return rows[0]
        ? {key: rows[0].setting_key, value: parseJsonColumn(rows[0].setting_value), updatedAt: rows[0].updated_at.toISOString()}
        : null;
    },
    async setSecret(key, value) {
      await pool.query(`
        INSERT INTO secrets (secret_key, secret_value, updated_at)
        VALUES (?, ?, NOW())
        ON DUPLICATE KEY UPDATE secret_value = VALUES(secret_value), updated_at = NOW()
      `, [key, JSON.stringify(value)]);
      return this.getSecret(key);
    },
    async getSecret(key) {
      const [rows] = await pool.query("SELECT * FROM secrets WHERE secret_key = ? LIMIT 1", [key]);
      return rows[0]
        ? {key: rows[0].secret_key, value: parseJsonColumn(rows[0].secret_value), updatedAt: rows[0].updated_at.toISOString()}
        : null;
    },
    async listRequests() {
      const [rows] = await pool.query("SELECT * FROM requests ORDER BY created_at DESC");
      return rows.map((row) => ({
        id: row.id,
        source: row.source,
        title: row.title,
        requestType: row.request_type,
        notes: row.notes,
        requestedBy: row.requested_by,
        status: row.status_name,
        moderatorComment: row.moderator_comment,
        timeline: parseJsonColumn(row.timeline_json, []),
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString()
      }));
    },
    async createRequest(payload) {
      const timeline = [
        {
          type: "created",
          message: "Request created.",
          at: nowIso(),
          actor: payload.requestedBy
        }
      ];
      const [result] = await pool.query(`
        INSERT INTO requests (source, title, request_type, notes, requested_by, status_name, moderator_comment, timeline_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'pending', '', ?, NOW(), NOW())
      `, [payload.source, payload.title, payload.requestType, payload.notes || "", payload.requestedBy, JSON.stringify(timeline)]);
      const [rows] = await pool.query("SELECT * FROM requests WHERE id = ?", [result.insertId]);
      const row = rows[0];
      return {
        id: row.id,
        source: row.source,
        title: row.title,
        requestType: row.request_type,
        notes: row.notes,
        requestedBy: row.requested_by,
        status: row.status_name,
        moderatorComment: row.moderator_comment,
        timeline: parseJsonColumn(row.timeline_json, []),
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString()
      };
    },
    async reviewRequest(id, review) {
      const [rows] = await pool.query("SELECT * FROM requests WHERE id = ? LIMIT 1", [id]);
      if (!rows[0]) {
        return null;
      }
      const timeline = parseJsonColumn(rows[0].timeline_json, []);
      timeline.push({
        type: review.status,
        message: review.comment || `Request ${review.status}.`,
        at: nowIso(),
        actor: review.actor
      });
      await pool.query(`
        UPDATE requests
        SET status_name = ?, moderator_comment = ?, timeline_json = ?, updated_at = NOW()
        WHERE id = ?
      `, [review.status, review.comment || "", JSON.stringify(timeline), id]);
      const [updated] = await pool.query("SELECT * FROM requests WHERE id = ? LIMIT 1", [id]);
      const row = updated[0];
      return {
        id: row.id,
        source: row.source,
        title: row.title,
        requestType: row.request_type,
        notes: row.notes,
        requestedBy: row.requested_by,
        status: row.status_name,
        moderatorComment: row.moderator_comment,
        timeline: parseJsonColumn(row.timeline_json, []),
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString()
      };
    },
    async upsertProgress(entry) {
      await pool.query(`
        INSERT INTO media_progress (media_id, discord_user_id, chapter_label, position_ratio, bookmark_json, updated_at)
        VALUES (?, ?, ?, ?, ?, NOW())
        ON DUPLICATE KEY UPDATE chapter_label = VALUES(chapter_label), position_ratio = VALUES(position_ratio),
        bookmark_json = VALUES(bookmark_json), updated_at = NOW()
      `, [entry.mediaId, entry.discordUserId, entry.chapterLabel, entry.positionRatio, entry.bookmark ? JSON.stringify(entry.bookmark) : null]);
      return entry;
    },
    async getProgressByUser(discordUserId) {
      const [rows] = await pool.query("SELECT * FROM media_progress WHERE discord_user_id = ? ORDER BY updated_at DESC", [discordUserId]);
      return rows.map((row) => ({
        mediaId: row.media_id,
        discordUserId: row.discord_user_id,
        chapterLabel: row.chapter_label,
        positionRatio: row.position_ratio,
        bookmark: parseJsonColumn(row.bookmark_json),
        updatedAt: row.updated_at.toISOString()
      }));
    },
    async listRavenTitles() {
      const [titleRows] = await pool.query("SELECT * FROM raven_titles ORDER BY title ASC");
      if (!titleRows.length) {
        return [];
      }
      const [chapterRows] = await pool.query("SELECT * FROM raven_chapters");
      const chaptersByTitle = new Map();
      for (const row of chapterRows) {
        if (!chaptersByTitle.has(row.title_id)) {
          chaptersByTitle.set(row.title_id, []);
        }
        chaptersByTitle.get(row.title_id).push(toRavenChapter(row));
      }
      return titleRows.map((row) => toRavenTitle(row, chaptersByTitle.get(row.title_id) || []));
    },
    async getRavenTitle(titleId) {
      const [titleRows] = await pool.query("SELECT * FROM raven_titles WHERE title_id = ? LIMIT 1", [titleId]);
      if (!titleRows[0]) {
        return null;
      }
      const [chapterRows] = await pool.query("SELECT * FROM raven_chapters WHERE title_id = ?", [titleId]);
      return toRavenTitle(titleRows[0], chapterRows.map(toRavenChapter));
    },
    async upsertRavenTitle(title) {
      await pool.query(`
        INSERT INTO raven_titles (
          title_id, title, media_type, status_name, latest_chapter, cover_accent, summary, release_label,
          chapter_count, chapters_downloaded, author_name, tags_json, aliases_json, relations_json,
          metadata_provider, metadata_matched_at, source_url, cover_url, download_root, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
        ON DUPLICATE KEY UPDATE
          title = VALUES(title),
          media_type = VALUES(media_type),
          status_name = VALUES(status_name),
          latest_chapter = VALUES(latest_chapter),
          cover_accent = VALUES(cover_accent),
          summary = VALUES(summary),
          release_label = VALUES(release_label),
          chapter_count = VALUES(chapter_count),
          chapters_downloaded = VALUES(chapters_downloaded),
          author_name = VALUES(author_name),
          tags_json = VALUES(tags_json),
          aliases_json = VALUES(aliases_json),
          relations_json = VALUES(relations_json),
          metadata_provider = VALUES(metadata_provider),
          metadata_matched_at = VALUES(metadata_matched_at),
          source_url = VALUES(source_url),
          cover_url = VALUES(cover_url),
          download_root = VALUES(download_root),
          updated_at = NOW()
      `, [
        title.id,
        title.title,
        title.mediaType || "manga",
        title.status || "active",
        title.latestChapter || "",
        title.coverAccent || "#4f8f88",
        title.summary || "",
        title.releaseLabel || "",
        Number.parseInt(String(title.chapterCount || 0), 10) || 0,
        Number.parseInt(String(title.chaptersDownloaded || 0), 10) || 0,
        title.author || "",
        JSON.stringify(Array.isArray(title.tags) ? title.tags : []),
        JSON.stringify(Array.isArray(title.aliases) ? title.aliases : []),
        JSON.stringify(Array.isArray(title.relations) ? title.relations : []),
        title.metadataProvider || null,
        title.metadataMatchedAt || null,
        title.sourceUrl || null,
        title.coverUrl || null,
        title.downloadRoot || null
      ]);
      return this.getRavenTitle(title.id);
    },
    async replaceRavenChapters(titleId, chapters) {
      await pool.query("DELETE FROM raven_chapters WHERE title_id = ?", [titleId]);
      for (const chapter of sortRavenChapters(Array.isArray(chapters) ? chapters : [])) {
        await pool.query(`
          INSERT INTO raven_chapters (
            title_id, chapter_id, label_name, chapter_number, page_count, release_date, is_available, archive_path, source_url, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
        `, [
          titleId,
          chapter.id,
          chapter.label || chapter.id,
          chapter.chapterNumber || null,
          Number.parseInt(String(chapter.pageCount || 0), 10) || 0,
          chapter.releaseDate || null,
          chapter.available === false ? 0 : 1,
          chapter.archivePath || null,
          chapter.sourceUrl || null
        ]);
      }
      const [rows] = await pool.query("SELECT * FROM raven_chapters WHERE title_id = ?", [titleId]);
      return rows.map(toRavenChapter);
    },
    async listRavenDownloadTasks() {
      const [rows] = await pool.query("SELECT * FROM raven_download_tasks ORDER BY queued_at DESC");
      return rows.map((row) => ({
        taskId: row.task_id,
        titleId: row.title_id,
        titleName: row.title_name,
        titleUrl: row.title_url,
        requestType: row.request_type,
        requestedBy: row.requested_by,
        status: row.status_name,
        message: row.message_text,
        percent: row.percent_value,
        queuedAt: row.queued_at.toISOString(),
        updatedAt: row.updated_at.toISOString()
      }));
    },
    async upsertRavenDownloadTask(task) {
      await pool.query(`
        INSERT INTO raven_download_tasks (
          task_id, title_id, title_name, title_url, request_type, requested_by, status_name, message_text, percent_value, queued_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
        ON DUPLICATE KEY UPDATE
          title_id = VALUES(title_id),
          title_name = VALUES(title_name),
          title_url = VALUES(title_url),
          request_type = VALUES(request_type),
          requested_by = VALUES(requested_by),
          status_name = VALUES(status_name),
          message_text = VALUES(message_text),
          percent_value = VALUES(percent_value),
          queued_at = VALUES(queued_at),
          updated_at = NOW()
      `, [
        task.taskId,
        task.titleId || null,
        task.titleName,
        task.titleUrl,
        task.requestType || "manga",
        task.requestedBy || "scriptarr",
        task.status || "queued",
        task.message || "",
        Number.parseInt(String(task.percent || 0), 10) || 0,
        task.queuedAt || nowIso()
      ]);
      const [rows] = await pool.query("SELECT * FROM raven_download_tasks WHERE task_id = ? LIMIT 1", [task.taskId]);
      const row = rows[0];
      return {
        taskId: row.task_id,
        titleId: row.title_id,
        titleName: row.title_name,
        titleUrl: row.title_url,
        requestType: row.request_type,
        requestedBy: row.requested_by,
        status: row.status_name,
        message: row.message_text,
        percent: row.percent_value,
        queuedAt: row.queued_at.toISOString(),
        updatedAt: row.updated_at.toISOString()
      };
    },
    async getRavenMetadataMatch(titleId) {
      const [rows] = await pool.query("SELECT * FROM raven_metadata_matches WHERE title_id = ? LIMIT 1", [titleId]);
      const row = rows[0];
      return row
        ? {
          titleId: row.title_id,
          provider: row.provider_id,
          providerSeriesId: row.provider_series_id,
          details: parseJsonColumn(row.details_json, {}),
          updatedAt: row.updated_at.toISOString()
        }
        : null;
    },
    async setRavenMetadataMatch(titleId, value) {
      await pool.query(`
        INSERT INTO raven_metadata_matches (title_id, provider_id, provider_series_id, details_json, updated_at)
        VALUES (?, ?, ?, ?, NOW())
        ON DUPLICATE KEY UPDATE
          provider_id = VALUES(provider_id),
          provider_series_id = VALUES(provider_series_id),
          details_json = VALUES(details_json),
          updated_at = NOW()
      `, [
        titleId,
        value.provider || "",
        value.providerSeriesId || "",
        JSON.stringify(value.details || {})
      ]);
      return this.getRavenMetadataMatch(titleId);
    }
  };
};

export const createStore = (config) => config.driver === "mysql" ? createMysqlStore(config) : createMemoryStore();
