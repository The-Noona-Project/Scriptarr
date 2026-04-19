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
    }
  };
};

export const createStore = (config) => config.driver === "mysql" ? createMysqlStore(config) : createMemoryStore();
