import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

process.env.NODE_ENV = "test";

const {createPortalApp} = await import("../lib/createPortalApp.mjs");

const withPortalEnv = async (overrides, handler) => {
  const keys = [
    "SCRIPTARR_SAGE_BASE_URL",
    "SCRIPTARR_SERVICE_TOKEN",
    "SCRIPTARR_PORTAL_SERVICE_TOKEN",
    "SCRIPTARR_VAULT_BASE_URL",
    "SCRIPTARR_ORACLE_BASE_URL",
    "DISCORD_TOKEN"
  ];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));

  for (const key of keys) {
    if (Object.hasOwn(overrides, key)) {
      process.env[key] = overrides[key];
    } else {
      delete process.env[key];
    }
  }

  try {
    await handler();
  } finally {
    for (const [key, value] of previous) {
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
};

const createJsonServer = async (routes) => {
  const hits = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const bodyText = Buffer.concat(chunks).toString("utf8");
    const body = bodyText ? JSON.parse(bodyText) : null;
    hits.push({
      method: req.method,
      path: url.pathname,
      headers: req.headers,
      body
    });

    const key = `${req.method} ${url.pathname}`;
    const route = routes[key];
    if (!route) {
      res.writeHead(404, {"Content-Type": "application/json"});
      res.end(JSON.stringify({error: `No route for ${key}`}));
      return;
    }

    const result = await route({req, url, body, hits});
    res.writeHead(result.status || 200, {"Content-Type": "application/json"});
    res.end(JSON.stringify(result.body ?? null));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    hits,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
};

const createPortalServer = async () => {
  const {app} = await createPortalApp();
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
};

test("portal exposes the new Discord command catalog", async () => {
  await withPortalEnv({}, async () => {
    const portal = await createPortalServer();

    try {
      const payload = await fetch(`${portal.baseUrl}/api/commands`).then((response) => response.json());
      assert.ok(payload.commands.some((command) => command.name === "chat"));
      assert.ok(payload.commands.some((command) => command.name === "request"));
    } finally {
      await portal.close();
    }
  });
});

test("portal creates Discord requests through Sage's internal broker routes", async () => {
  const sage = await createJsonServer({
    "POST /api/internal/vault/users/upsert-discord": async ({req, body}) => {
      assert.equal(req.headers.authorization, "Bearer portal-service-token");
      assert.deepEqual(body, {
        discordUserId: "253987219969146890",
        username: "CaptainPax",
        avatarUrl: "https://cdn.example/avatar.png",
        role: "member"
      });
      return {
        body: {
          discordUserId: body.discordUserId,
          username: body.username,
          role: body.role
        }
      };
    },
    "POST /api/internal/vault/requests": async ({req, body}) => {
      assert.equal(req.headers.authorization, "Bearer portal-service-token");
      assert.deepEqual(body, {
        source: "discord",
        title: "Dandadan",
        requestType: "manga",
        notes: "Please add this",
        requestedBy: "253987219969146890"
      });
      return {
        status: 201,
        body: {
          id: "req_123",
          ...body,
          status: "pending"
        }
      };
    }
  });

  await withPortalEnv({
    SCRIPTARR_SAGE_BASE_URL: sage.baseUrl,
    SCRIPTARR_SERVICE_TOKEN: "portal-service-token",
    SCRIPTARR_VAULT_BASE_URL: "http://127.0.0.1:65500",
    SCRIPTARR_ORACLE_BASE_URL: "http://127.0.0.1:65501"
  }, async () => {
    const portal = await createPortalServer();

    try {
      const response = await fetch(`${portal.baseUrl}/api/requests/from-discord`, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({
          discordUserId: "253987219969146890",
          username: "CaptainPax",
          avatarUrl: "https://cdn.example/avatar.png",
          title: "Dandadan",
          requestType: "manga",
          notes: "Please add this"
        })
      });

      assert.equal(response.status, 201);
      assert.deepEqual(await response.json(), {
        id: "req_123",
        source: "discord",
        title: "Dandadan",
        requestType: "manga",
        notes: "Please add this",
        requestedBy: "253987219969146890",
        status: "pending"
      });
      assert.deepEqual(
        sage.hits.map((hit) => hit.path),
        [
          "/api/internal/vault/users/upsert-discord",
          "/api/internal/vault/requests"
        ]
      );
    } finally {
      await portal.close();
    }
  });

  await sage.close();
});

test("portal routes chat through Sage's Oracle broker route", async () => {
  const sage = await createJsonServer({
    "POST /api/internal/oracle/chat": async ({req, body}) => {
      assert.equal(req.headers.authorization, "Bearer portal-service-token");
      assert.deepEqual(body, {message: "how is scriptarr doing?"});
      return {
        body: {
          ok: true,
          reply: "Noona says the stack looks healthy."
        }
      };
    }
  });

  await withPortalEnv({
    SCRIPTARR_SAGE_BASE_URL: sage.baseUrl,
    SCRIPTARR_SERVICE_TOKEN: "portal-service-token",
    SCRIPTARR_ORACLE_BASE_URL: "http://127.0.0.1:65501"
  }, async () => {
    const portal = await createPortalServer();

    try {
      const response = await fetch(`${portal.baseUrl}/api/chat`, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({message: "how is scriptarr doing?"})
      });

      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        ok: true,
        reply: "Noona says the stack looks healthy."
      });
      assert.deepEqual(
        sage.hits.map((hit) => hit.path),
        ["/api/internal/oracle/chat"]
      );
    } finally {
      await portal.close();
    }
  });

  await sage.close();
});
