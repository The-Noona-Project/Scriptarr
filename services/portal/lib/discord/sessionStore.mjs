import crypto from "node:crypto";

export const createSessionStore = ({ttlMs}) => {
  const sessions = new Map();

  const sweep = () => {
    const now = Date.now();
    for (const [key, session] of sessions) {
      if (session.expiresAt <= now) {
        sessions.delete(key);
      }
    }
  };

  return {
    create(payload) {
      sweep();
      const id = crypto.randomUUID();
      sessions.set(id, {
        ...payload,
        expiresAt: Date.now() + ttlMs
      });
      return id;
    },
    read(id) {
      sweep();
      const session = sessions.get(id);
      return session || null;
    },
    delete(id) {
      sessions.delete(id);
    }
  };
};
