import test from "node:test";
import assert from "node:assert/strict";

process.env.SCRIPTARR_VAULT_DRIVER = "memory";
process.env.SCRIPTARR_SERVICE_TOKENS = JSON.stringify({"scriptarr-sage": "sage-dev-token"});

const {createVaultApp} = await import("../lib/createVaultApp.mjs");

test("vault exposes bootstrap status and request intake lifecycle", async () => {
  const {app} = await createVaultApp();
  const server = app.listen(0);
  const {port} = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  const bootstrap = await fetch(`${baseUrl}/api/public/bootstrap-status`).then((response) => response.json());
  assert.equal(bootstrap.ownerClaimed, false);

  const headers = {
    "Authorization": "Bearer sage-dev-token",
    "Content-Type": "application/json"
  };

  const request = await fetch(`${baseUrl}/api/service/requests`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      source: "moon",
      title: "Dandadan",
      requestType: "manga",
      notes: "Please add volume extras",
      requestedBy: "123",
      details: {
        query: "dandadan",
        selectedMetadata: {
          provider: "mangadex",
          providerSeriesId: "md-1",
          title: "Dandadan"
        },
        selectedDownload: null,
        availability: "unavailable"
      }
    })
  }).then((response) => response.json());

  assert.equal(request.status, "unavailable");
  assert.equal(request.details.query, "dandadan");
  assert.equal(request.workKey, "metadata:mangadex::md-1");
  assert.equal(request.details.requestWorkKey, "metadata:mangadex::md-1");
  assert.equal(request.timeline.at(-1).type, "unavailable");

  const updated = await fetch(`${baseUrl}/api/service/requests/${request.id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({
      status: "queued",
      detailsMerge: {
        selectedDownload: {
          providerId: "weebcentral",
          titleUrl: "https://weebcentral.com/series/abc",
          titleName: "Dandadan"
        },
        availability: "available",
        jobId: "job-1",
        taskId: "task-1"
      },
      eventType: "queued",
      actor: "owner"
    })
  }).then((response) => response.json());

  assert.equal(updated.status, "queued");
  assert.equal(updated.details.jobId, "job-1");
  assert.equal(updated.details.taskId, "task-1");
  assert.equal(updated.workKey, "download:weebcentral::https://weebcentral.com/series/abc");
  assert.equal(updated.details.requestWorkKind, "download");
  assert.equal(updated.timeline.at(-1).actor, "owner");

  const setting = await fetch(`${baseUrl}/api/service/settings/oracle.settings`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      value: {
        enabled: false,
        provider: "openai"
      }
    })
  }).then((response) => response.json());

  assert.equal(setting.value.provider, "openai");

  const secret = await fetch(`${baseUrl}/api/service/secrets/oracle.openai.apiKey`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      value: "test-openai-key"
    })
  }).then((response) => response.json());

  assert.equal(secret.value, "test-openai-key");

  server.close();
});

test("vault durably rejects duplicate active request work keys and releases them when requests stop being active", async () => {
  const {app} = await createVaultApp();
  const server = app.listen(0);
  const {port} = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  const headers = {
    "Authorization": "Bearer sage-dev-token",
    "Content-Type": "application/json"
  };

  const first = await fetch(`${baseUrl}/api/service/requests`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      source: "moon",
      title: "One Piece",
      requestType: "manga",
      requestedBy: "123",
      status: "pending",
      details: {
        query: "one piece",
        selectedMetadata: {
          provider: "mangadex",
          providerSeriesId: "md-one-piece",
          title: "One Piece"
        },
        selectedDownload: {
          providerId: "weebcentral",
          titleUrl: "https://weebcentral.com/series/one-piece",
          titleName: "One Piece"
        },
        availability: "available"
      }
    })
  });
  assert.equal(first.status, 201);

  const duplicate = await fetch(`${baseUrl}/api/service/requests`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      source: "moon-admin",
      title: "One Piece",
      requestType: "manga",
      requestedBy: "456",
      status: "pending",
      details: {
        query: "one piece",
        selectedMetadata: {
          provider: "mangadex",
          providerSeriesId: "md-one-piece-alt",
          title: "One Piece"
        },
        selectedDownload: {
          providerId: "weebcentral",
          titleUrl: "https://weebcentral.com/series/one-piece",
          titleName: "One Piece"
        },
        availability: "available"
      }
    })
  });
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).code, "REQUEST_WORK_KEY_CONFLICT");

  const metadataFirst = await fetch(`${baseUrl}/api/service/requests`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      source: "moon",
      title: "Blue Box",
      requestType: "manga",
      requestedBy: "123",
      status: "unavailable",
      details: {
        query: "blue box",
        selectedMetadata: {
          provider: "mangadex",
          providerSeriesId: "md-blue-box",
          title: "Blue Box"
        },
        availability: "unavailable"
      }
    })
  });
  assert.equal(metadataFirst.status, 201);

  const metadataDuplicate = await fetch(`${baseUrl}/api/service/requests`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      source: "discord",
      title: "Blue Box",
      requestType: "manga",
      requestedBy: "789",
      status: "unavailable",
      details: {
        query: "blue box",
        selectedMetadata: {
          provider: "mangadex",
          providerSeriesId: "md-blue-box",
          title: "Blue Box"
        },
        availability: "unavailable"
      }
    })
  });
  assert.equal(metadataDuplicate.status, 409);
  assert.equal((await metadataDuplicate.json()).code, "REQUEST_WORK_KEY_CONFLICT");

  const alternateUnavailable = await fetch(`${baseUrl}/api/service/requests`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      source: "moon",
      title: "One Piece (Official Colored)",
      requestType: "manga",
      requestedBy: "123",
      status: "unavailable",
      details: {
        query: "one piece official colored",
        selectedMetadata: {
          provider: "mangadex",
          providerSeriesId: "md-one-piece-color",
          title: "One Piece (Official Colored)"
        },
        availability: "unavailable"
      }
    })
  });
  assert.equal(alternateUnavailable.status, 201);

  const conflictingResolve = await fetch(`${baseUrl}/api/service/requests/3`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({
      detailsMerge: {
        selectedDownload: {
          providerId: "weebcentral",
          titleUrl: "https://weebcentral.com/series/one-piece",
          titleName: "One Piece"
        },
        availability: "available"
      },
      actor: "owner-1"
    })
  });
  assert.equal(conflictingResolve.status, 409);
  assert.equal((await conflictingResolve.json()).code, "REQUEST_WORK_KEY_CONFLICT");

  const denied = await fetch(`${baseUrl}/api/service/requests/1`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({
      status: "denied",
      actor: "owner-1"
    })
  });
  assert.equal(denied.status, 200);

  const recreated = await fetch(`${baseUrl}/api/service/requests`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      source: "moon",
      title: "One Piece",
      requestType: "manga",
      requestedBy: "123",
      status: "pending",
      details: {
        query: "one piece",
        selectedMetadata: {
          provider: "mangadex",
          providerSeriesId: "md-one-piece",
          title: "One Piece"
        },
        selectedDownload: {
          providerId: "weebcentral",
          titleUrl: "https://weebcentral.com/series/one-piece",
          titleName: "One Piece"
        },
        availability: "available"
      }
    })
  });
  assert.equal(recreated.status, 201);

  server.close();
});

test("vault persists generic jobs and job tasks through the service API", async () => {
  const {app} = await createVaultApp();
  const server = app.listen(0);
  const {port} = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const headers = {
    "Authorization": "Bearer sage-dev-token",
    "Content-Type": "application/json"
  };

  const job = await fetch(`${baseUrl}/api/service/jobs/job-1`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      kind: "service-update",
      ownerService: "scriptarr-warden",
      status: "running",
      label: "Managed service update",
      payload: {
        requestedServices: ["scriptarr-moon"]
      }
    })
  }).then((response) => response.json());

  assert.equal(job.jobId, "job-1");
  assert.equal(job.kind, "service-update");

  const task = await fetch(`${baseUrl}/api/service/jobs/job-1/tasks/task-1`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      taskKey: "pull-images",
      label: "Pull candidate images",
      status: "completed",
      percent: 100
    })
  }).then((response) => response.json());

  assert.equal(task.taskId, "task-1");
  assert.equal(task.jobId, "job-1");

  const listedJobs = await fetch(`${baseUrl}/api/service/jobs?ownerService=scriptarr-warden&kind=service-update`, {
    headers
  }).then((response) => response.json());
  assert.equal(listedJobs.length, 1);
  assert.equal(listedJobs[0].jobId, "job-1");

  const listedTasks = await fetch(`${baseUrl}/api/service/jobs/job-1/tasks`, {
    headers
  }).then((response) => response.json());
  assert.equal(listedTasks.length, 1);
  assert.equal(listedTasks[0].taskKey, "pull-images");

  server.close();
});

test("vault stores brokered portal discord settings and user-scoped follow state", async () => {
  const {app} = await createVaultApp();
  const server = app.listen(0);
  const {port} = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const headers = {
    "Authorization": "Bearer sage-dev-token",
    "Content-Type": "application/json"
  };

  const discordSettings = await fetch(`${baseUrl}/api/service/settings/portal.discord`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      value: {
        guildId: "guild-123",
        superuserId: "owner-1",
        onboarding: {
          channelId: "channel-456",
          template: "Welcome to {siteName}, {username}!"
        },
        commands: {
          request: {
            enabled: true,
            roleId: "role-request"
          }
        }
      }
    })
  }).then((response) => response.json());

  assert.equal(discordSettings.value.guildId, "guild-123");
  assert.equal(discordSettings.value.onboarding.channelId, "channel-456");

  const following = await fetch(`${baseUrl}/api/service/settings/moon.following.discord-123`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      value: [{
        titleId: "dan-da-dan",
        title: "Dandadan",
        libraryTypeSlug: "webtoon"
      }]
    })
  }).then((response) => response.json());

  assert.equal(following.value[0].titleId, "dan-da-dan");

  const loadedFollowing = await fetch(`${baseUrl}/api/service/settings/moon.following.discord-123`, {
    headers
  }).then((response) => response.json());
  assert.equal(loadedFollowing.value[0].libraryTypeSlug, "webtoon");

  server.close();
});

test("vault persists Raven titles with cover and managed roots", async () => {
  const {app} = await createVaultApp();
  const server = app.listen(0);
  const {port} = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const headers = {
    "Authorization": "Bearer sage-dev-token",
    "Content-Type": "application/json"
  };

  const title = await fetch(`${baseUrl}/api/service/raven/titles/title-1`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      id: "title-1",
      title: "Solo Leveling: Ragnarok",
      mediaType: "manhwa",
      libraryTypeLabel: "Manhwa",
      libraryTypeSlug: "manhwa",
      status: "active",
      latestChapter: "46",
      chapterCount: 46,
      chaptersDownloaded: 46,
      coverUrl: "https://cdn.example.com/solo.jpg",
      workingRoot: "/downloads/downloading/manhwa/Solo_Leveling_Ragnarok",
      downloadRoot: "/downloads/downloaded/manhwa/Solo_Leveling_Ragnarok",
      chapters: [{
        id: "title-1-c45",
        label: "Chapter 45",
        chapterNumber: "45",
        pageCount: 18,
        releaseDate: "2026-04-20",
        available: true,
        archivePath: "/downloads/downloaded/manhwa/Solo_Leveling_Ragnarok/Chapter_45.cbz",
        sourceUrl: "https://weebcentral.com/chapters/title-1-45"
      }, {
        id: "title-1-c46",
        label: "Chapter 46",
        chapterNumber: "46",
        pageCount: 21,
        releaseDate: "2026-04-21",
        available: true,
        archivePath: "/downloads/downloaded/manhwa/Solo_Leveling_Ragnarok/Chapter_46.cbz",
        sourceUrl: "https://weebcentral.com/chapters/title-1-46"
      }]
    })
  }).then((response) => response.json());

  assert.equal(title.id, "title-1");
  assert.equal(title.coverUrl, "https://cdn.example.com/solo.jpg");
  assert.equal(title.downloadRoot, "/downloads/downloaded/manhwa/Solo_Leveling_Ragnarok");
  assert.equal(title.chapters.length, 2);
  assert.equal(title.chapters[0].id, "title-1-c45");

  const listed = await fetch(`${baseUrl}/api/service/raven/titles`, {
    headers
  }).then((response) => response.json());
  assert.equal(listed.length, 1);
  assert.equal(listed[0].workingRoot, "/downloads/downloading/manhwa/Solo_Leveling_Ragnarok");
  assert.equal(listed[0].chapters.length, 2);

  server.close();
});

test("vault returns conflicts for duplicate owner claims and stale request revisions", async () => {
  const {app} = await createVaultApp();
  const server = app.listen(0);
  const {port} = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const headers = {
    "Authorization": "Bearer sage-dev-token",
    "Content-Type": "application/json"
  };

  const firstOwner = await fetch(`${baseUrl}/api/service/users/upsert-discord`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      discordUserId: "owner-1",
      username: "Owner One",
      claimOwner: true
    })
  });
  assert.equal(firstOwner.status, 200);

  const duplicateOwner = await fetch(`${baseUrl}/api/service/users/upsert-discord`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      discordUserId: "owner-2",
      username: "Owner Two",
      claimOwner: true
    })
  });
  assert.equal(duplicateOwner.status, 409);
  assert.equal((await duplicateOwner.json()).code, "OWNER_ALREADY_CLAIMED");

  const request = await fetch(`${baseUrl}/api/service/requests`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      source: "moon",
      title: "Blame!",
      requestType: "manga",
      notes: "",
      requestedBy: "owner-1"
    })
  }).then((response) => response.json());

  const updated = await fetch(`${baseUrl}/api/service/requests/${request.id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({
      status: "queued",
      eventType: "queued",
      actor: "owner-1",
      revision: request.revision
    })
  });
  assert.equal(updated.status, 200);

  const stale = await fetch(`${baseUrl}/api/service/requests/${request.id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({
      status: "denied",
      actor: "owner-1",
      revision: request.revision
    })
  });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).code, "REQUEST_REVISION_CONFLICT");

  server.close();
});

test("vault manages permission groups, durable events, and deleted-user recreation through the default group", async () => {
  const {app} = await createVaultApp();
  const server = app.listen(0);
  const {port} = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const headers = {
    "Authorization": "Bearer sage-dev-token",
    "Content-Type": "application/json"
  };

  const owner = await fetch(`${baseUrl}/api/service/users/upsert-discord`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      discordUserId: "owner-1",
      username: "Owner One",
      claimOwner: true
    })
  }).then((response) => response.json());
  assert.equal(owner.role, "owner");

  const reader = await fetch(`${baseUrl}/api/service/users/upsert-discord`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      discordUserId: "reader-1",
      username: "Reader One"
    })
  }).then((response) => response.json());
  assert.equal(reader.role, "member");
  assert.equal(reader.groups[0].id, "member");

  const accessOverview = await fetch(`${baseUrl}/api/service/access`, {
    headers
  }).then((response) => response.json());
  assert.equal(accessOverview.defaultGroupId, "member");
  assert.equal(accessOverview.groups.length >= 3, true);

  const opsGroup = await fetch(`${baseUrl}/api/service/permission-groups`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: "Requests Ops",
      description: "Custom request moderators",
      permissions: ["read_library", "read_requests"],
      adminGrants: {
        requests: "root",
        users: "read"
      }
    })
  }).then((response) => response.json());
  assert.equal(opsGroup.id, "requests-ops");
  assert.equal(opsGroup.adminGrants.requests, "root");

  const updatedReader = await fetch(`${baseUrl}/api/service/users/reader-1/groups`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      groupIds: ["requests-ops"]
    })
  }).then((response) => response.json());
  assert.deepEqual(updatedReader.groups.map((group) => group.id), ["requests-ops"]);
  assert.equal(updatedReader.adminGrants.requests, "root");

  await fetch(`${baseUrl}/api/service/progress`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      mediaId: "dice",
      discordUserId: "reader-1",
      chapterLabel: "Chapter 388",
      positionRatio: 0.5,
      bookmark: {
        page: 12
      }
    })
  });

  await fetch(`${baseUrl}/api/service/events`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      domain: "users",
      eventType: "group-updated",
      actorType: "owner",
      actorId: "owner-1",
      actorLabel: "Owner One",
      targetType: "permission-group",
      targetId: "requests-ops",
      message: "Owner One updated the Requests Ops group.",
      createdAt: "2025-01-01T00:00:00.000Z"
    })
  });
  await fetch(`${baseUrl}/api/service/events`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      domain: "access",
      eventType: "user-groups-updated",
      actorType: "owner",
      actorId: "owner-1",
      actorLabel: "Owner One",
      targetType: "user",
      targetId: "reader-1",
      message: "Owner One updated Reader One's groups."
    })
  });

  const accessEvents = await fetch(`${baseUrl}/api/service/events?domain=access`, {
    headers
  }).then((response) => response.json());
  assert.equal(accessEvents.length, 1);
  assert.equal(accessEvents[0].domain, "access");

  const pruneResult = await fetch(`${baseUrl}/api/service/events/prune?retentionDays=30`, {
    method: "DELETE",
    headers
  }).then((response) => response.json());
  assert.equal(pruneResult.removed >= 1, true);

  const deletedUser = await fetch(`${baseUrl}/api/service/users/reader-1`, {
    method: "DELETE",
    headers
  }).then((response) => response.json());
  assert.equal(deletedUser.discordUserId, "reader-1");

  const preservedProgress = await fetch(`${baseUrl}/api/service/progress/reader-1`, {
    headers
  }).then((response) => response.json());
  assert.equal(preservedProgress.length, 1);
  assert.equal(preservedProgress[0].chapterLabel, "Chapter 388");

  const recreatedReader = await fetch(`${baseUrl}/api/service/users/upsert-discord`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      discordUserId: "reader-1",
      username: "Reader One Again"
    })
  }).then((response) => response.json());
  assert.equal(recreatedReader.role, "member");
  assert.equal(recreatedReader.groups[0].id, "member");

  server.close();
});
