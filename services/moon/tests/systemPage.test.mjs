import test from "node:test";
import assert from "node:assert/strict";

import {renderSystemPage} from "../apps/admin/assets/pages/systemPage.js";

test("system status page prefers runtime network and nested mysql mode details", () => {
  const html = renderSystemPage({
    ok: true,
    routeId: "system-status",
    payload: {
      services: {
        warden: {
          ok: true,
          service: "scriptarr-warden"
        }
      },
      bootstrap: {
        managedNetworkName: "scriptarr-network-bootstrap",
        mysql: {
          mode: "external"
        },
        services: [{
          name: "scriptarr-moon",
          image: "scriptarr-moon:latest",
          containerName: "scriptarr-moon"
        }]
      },
      runtime: {
        managedNetworkName: "scriptarr-network-runtime",
        stackMode: "test",
        mysql: {
          mode: "selfhost"
        }
      }
    }
  });

  assert.match(html, /scriptarr-network-runtime/);
  assert.match(html, /selfhost/);
  assert.match(html, /test/);
  assert.doesNotMatch(html, /scriptarr-network-bootstrap.*external/);
  assert.doesNotMatch(html, /Â·/);
  assert.match(html, /&middot;/);
});

test("system updates page renders actionable update controls and digest status", () => {
  const html = renderSystemPage({
    ok: true,
    routeId: "system-updates",
    payload: {
      checkedAt: "2026-04-19T18:00:00.000Z",
      job: {
        jobId: "update_abc123",
        status: "running",
        requestedServices: ["scriptarr-moon"]
      },
      services: [{
        name: "scriptarr-moon",
        updateAvailable: true,
        runningImageLabel: "old-image",
        localImageLabel: "new-image",
        containerName: "scriptarr-moon",
        image: "docker.darkmatterservers.com/the-noona-project/scriptarr-moon:latest"
      }]
    }
  });

  assert.match(html, /Check now/);
  assert.match(html, /Install selected/);
  assert.match(html, /Install all/);
  assert.match(html, /Update available/);
  assert.match(html, /old-image/);
  assert.match(html, /new-image/);
});
