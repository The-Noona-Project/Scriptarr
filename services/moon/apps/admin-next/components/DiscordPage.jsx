"use client";

/**
 * @file Dedicated Discord settings page for Moon admin.
 */

import {useEffect, useMemo, useState} from "react";
import {hasAdminGrant} from "../lib/access.js";
import {requestJson, useAdminEventStaleness, useAdminJson} from "../lib/api.js";
import {buildDiscordCommandRows, normalizeDiscordSettings} from "../lib/adminDiscord.js";
import {formatDate, formatDisplayValue, normalizeString} from "../lib/format.js";
import {AdminActionBanner, AdminDenseTable, AdminStatusBadge} from "./AdminUi.jsx";

const normalizeArray = (value) => Array.isArray(value) ? value : [];

const parseChannelIds = (value) => normalizeString(value)
  .split(/[\s,]+/g)
  .map((entry) => normalizeString(entry))
  .filter(Boolean);

const formatChannelIds = (value) => normalizeArray(value).map((entry) => normalizeString(entry)).filter(Boolean).join("\n");

const patchNested = (source, key, patch) => ({
  ...source,
  [key]: {
    ...(source[key] || {}),
    ...patch
  }
});

/**
 * Render the dedicated Discord admin page.
 *
 * @param {{user: Record<string, any>}} props
 * @returns {import("react").ReactNode}
 */
export const DiscordPage = ({user}) => {
  const {loading, refreshing, error, data, refresh, setData} = useAdminJson("/api/moon/v3/admin/discord", {
    fallback: {settings: normalizeDiscordSettings({}), runtime: {}, commandCatalog: []}
  });
  const [draft, setDraft] = useState(() => normalizeDiscordSettings({}));
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [failure, setFailure] = useState("");
  const live = useAdminEventStaleness({
    domains: ["discord"],
    locked: busy !== "",
    onStale: () => {},
    onRefresh: refresh
  });
  const canWrite = hasAdminGrant(user, "discord", "write");
  const canRevealTriviaAnswer = hasAdminGrant(user, "discord", "root");
  const [answerCopied, setAnswerCopied] = useState(false);

  useEffect(() => {
    setDraft(normalizeDiscordSettings(data?.settings));
  }, [data?.settings]);

  const persistDraft = async () => {
    const result = await requestJson("/api/moon/v3/admin/discord", {
      method: "PUT",
      json: draft
    });
    if (!result.ok) {
      return result;
    }
    setData(result.payload);
    setDraft(normalizeDiscordSettings(result.payload?.settings));
    return result;
  };

  const commandRows = useMemo(() => buildDiscordCommandRows(
    draft,
    data?.commandCatalog,
    data?.runtime?.commandInventory
  ), [data?.commandCatalog, data?.runtime?.commandInventory, draft]);

  const setField = (patch) => setDraft((current) => ({...current, ...patch}));
  const setOnboarding = (patch) => setDraft((current) => patchNested(current, "onboarding", patch));
  const setNotifications = (patch) => setDraft((current) => patchNested(current, "notifications", patch));
  const setNoonaChat = (patch) => setDraft((current) => patchNested(current, "noonaChat", patch));
  const setTrivia = (patch) => setDraft((current) => patchNested(current, "trivia", patch));
  const setCommand = (id, patch) => setDraft((current) => ({
    ...current,
    commands: {
      ...current.commands,
      [id]: {
        ...(current.commands[id] || {enabled: true, roleId: ""}),
        ...patch
      }
    }
  }));

  const runAction = async (label, url, options = {}, onSuccess = null) => {
    setBusy(label);
    setNotice("");
    setFailure("");
    const result = await requestJson(url, options);
    setBusy("");
    if (!result.ok) {
      setFailure(result.payload?.error || `${label} failed.`);
      return;
    }
    onSuccess?.(result.payload);
    setNotice(result.payload?.queued ? `${label} queued.` : `${label} completed.`);
  };

  const saveThenRunAction = async (label, url, options = {}, onSuccess = null) => {
    setBusy(label);
    setNotice("");
    setFailure("");
    const saved = await persistDraft();
    if (!saved.ok) {
      setBusy("");
      setFailure(saved.payload?.error || "Discord settings could not be saved before that action.");
      return;
    }
    const result = await requestJson(url, options);
    setBusy("");
    if (!result.ok) {
      setFailure(result.payload?.error || `${label} failed.`);
      return;
    }
    onSuccess?.(result.payload);
    setNotice(result.payload?.queued ? `${label} queued.` : `${label} completed.`);
  };

  const save = () => runAction(
    "Save Discord settings",
    "/api/moon/v3/admin/discord",
    {method: "PUT", json: draft},
    (payload) => {
      setData(payload);
      setDraft(normalizeDiscordSettings(payload?.settings));
    }
  );

  const reload = () => runAction(
    "Reload Discord runtime",
    "/api/moon/v3/admin/discord/runtime/reload",
    {method: "POST", json: {}},
    setData
  );

  const testOnboarding = () => runAction(
    "Send onboarding test",
    "/api/moon/v3/admin/discord/onboarding/test",
    {method: "POST", json: {...draft, username: user?.username || "Admin"}}
  );

  const testRelease = () => runAction(
    "Send release test",
    "/api/moon/v3/admin/discord/release-notifications/test",
    {method: "POST", json: draft}
  );

  const testUpdate = () => runAction(
    "Send update test",
    "/api/moon/v3/admin/discord/update-notifications/test",
    {method: "POST", json: draft}
  );

  const clearNoonaMemory = (scope = "all", discordUserId = "") => runAction(
    scope === "user" ? "Clear Noona user memory" : scope === "server" ? "Clear Noona server memory" : "Clear Noona memory",
    "/api/moon/v3/admin/discord/noona-memory",
    {method: "DELETE", json: {scope, discordUserId}},
    (payload) => setData((current) => ({
      ...(current || {}),
      noonaMemory: payload?.memory || current?.noonaMemory
    }))
  );

  const startTrivia = () => {
    if (!draft.trivia.enabled) {
      setFailure("Enable trivia before starting a round.");
      return;
    }
    if (!draft.trivia.channelId) {
      setFailure("Set a trivia channel id before starting a round.");
      return;
    }
    saveThenRunAction(
      "Start trivia",
      "/api/moon/v3/admin/discord/trivia/start",
      {method: "POST", json: {force: true}},
      () => void refresh()
    );
  };

  const stopTrivia = () => runAction(
    "Stop trivia",
    "/api/moon/v3/admin/discord/trivia/stop",
    {method: "POST", json: {}},
    () => void refresh()
  );

  const testLeaderboard = () => {
    if (!draft.trivia.channelId && !draft.trivia.leaderboardChannelId) {
      setFailure("Set a trivia or leaderboard channel id before posting a leaderboard.");
      return;
    }
    saveThenRunAction(
      "Post trivia leaderboard",
      "/api/moon/v3/admin/discord/trivia/leaderboard/test",
      {method: "POST", json: {window: "all", defer: true}}
    );
  };

  const copyTriviaAnswer = async (answer) => {
    const normalized = normalizeString(answer);
    if (!normalized) {
      return;
    }
    await navigator.clipboard?.writeText(normalized);
    setAnswerCopied(true);
    window.setTimeout(() => setAnswerCopied(false), 2000);
  };

  if (loading) {
    return (
      <section className="admin-panel admin-state-panel">
        <div className="admin-kicker">System</div>
        <h2>Loading Discord</h2>
        <p>Moon is loading Portal Discord settings and runtime state.</p>
      </section>
    );
  }

  if (error) {
    return (
      <section className="admin-panel admin-state-panel is-danger">
        <div className="admin-kicker">System</div>
        <h2>Discord unavailable</h2>
        <p>{error}</p>
      </section>
    );
  }

  const runtime = data?.runtime || {};
  const triviaRuntime = data?.triviaRuntime || {};
  const noonaMemory = data?.noonaMemory || {};
  const noonaUsers = normalizeArray(noonaMemory.users);
  const activeTriviaRound = triviaRuntime.activeRound || null;
  const latestTriviaRound = triviaRuntime.latestRound || activeTriviaRound || null;
  const triviaAnswer = normalizeString(activeTriviaRound?.answer || latestTriviaRound?.answer);
  const triviaAnswerUrl = normalizeString(latestTriviaRound?.moonTitleUrl || latestTriviaRound?.sourceUrl);
  const triviaGuesses = normalizeArray(triviaRuntime.recentGuesses);
  const commandCount = normalizeArray(runtime.commandInventory).length;

  return (
    <>
      <section className="admin-panel">
        <div className="admin-section-heading">
          <div>
            <div className="admin-kicker">System</div>
            <h2>Discord</h2>
            <p className="admin-muted">Guild workflow settings, slash-command access, onboarding, release posts, and Noona chat.</p>
          </div>
          <AdminStatusBadge tone={runtime.connected ? "good" : "warning"}>
            {refreshing ? "refreshing" : runtime.connected ? "connected" : formatDisplayValue(runtime.connectionState, "degraded")}
          </AdminStatusBadge>
        </div>
        {failure ? <AdminActionBanner tone="bad">{failure}</AdminActionBanner> : null}
        {notice ? <AdminActionBanner tone="good">{notice}</AdminActionBanner> : null}
        <div className="admin-metric-grid">
          <article className="admin-metric-card"><span>Auth</span><strong>{runtime.authConfigured ? "configured" : "missing"}</strong></article>
          <article className="admin-metric-card"><span>Bot token</span><strong>{runtime.botTokenConfigured ? "configured" : "missing"}</strong></article>
          <article className="admin-metric-card"><span>Registered guild</span><strong>{formatDisplayValue(runtime.registeredGuildId, "unknown")}</strong></article>
          <article className="admin-metric-card"><span>Commands</span><strong>{commandCount}</strong></article>
        </div>
        <div className="admin-log-meta">
          <span>Live stream: {live.state}</span>
          <span>Last sync: {formatDate(runtime.portal?.runtime?.lastSyncAt || runtime.lastSyncAt)}</span>
          <span>Last Noona mention: {formatDate(runtime.lastNoonaMentionAt)}</span>
          <span>Warning: {formatDisplayValue(runtime.warning || runtime.syncError || runtime.error, "none")}</span>
        </div>
      </section>

      <section className="admin-settings-grid">
        <article className="admin-panel">
          <div className="admin-section-heading">
            <div>
              <div className="admin-kicker">Guild</div>
              <h2>Runtime identifiers</h2>
            </div>
          </div>
          <div className="admin-task-form">
            <label>
              <span>Guild id</span>
              <input disabled={!canWrite} value={draft.guildId} onChange={(event) => setField({guildId: event.target.value})} />
            </label>
            <label>
              <span>Superuser id</span>
              <input disabled={!canWrite} value={draft.superuserId} onChange={(event) => setField({superuserId: event.target.value})} />
            </label>
            <label>
              <span>Release channel id</span>
              <input disabled={!canWrite} value={draft.notifications.releaseChannelId} onChange={(event) => setNotifications({releaseChannelId: event.target.value})} />
            </label>
            <label>
              <span>Update channel id</span>
              <input disabled={!canWrite} value={draft.notifications.updateChannelId} onChange={(event) => setNotifications({updateChannelId: event.target.value})} />
            </label>
          </div>
          <div className="admin-action-row">
            <button className="admin-button solid" type="button" disabled={!canWrite || busy !== ""} onClick={save}>Save settings</button>
            <button className="admin-button ghost" type="button" disabled={!canWrite || busy !== ""} onClick={reload}>Reload runtime</button>
            <button className="admin-button ghost" type="button" disabled={!canWrite || busy !== "" || !draft.notifications.releaseChannelId} onClick={testRelease}>Test release post</button>
            <button className="admin-button ghost" type="button" disabled={!canWrite || busy !== "" || !draft.notifications.updateChannelId} onClick={testUpdate}>Test update post</button>
          </div>
        </article>

        <article className="admin-panel">
          <div className="admin-section-heading">
            <div>
              <div className="admin-kicker">Noona Chat</div>
              <h2>Mention replies</h2>
              <p className="admin-muted">Public replies use the `/chat` role gate, Sage-curated memory, and conservative admin proposals.</p>
            </div>
            <AdminStatusBadge tone={draft.noonaChat.enabled ? "good" : "queued"}>
              {draft.noonaChat.enabled ? "enabled" : "disabled"}
            </AdminStatusBadge>
          </div>
          <div className="admin-task-form">
            <label>
              <span>Enabled</span>
              <select disabled={!canWrite} value={draft.noonaChat.enabled ? "true" : "false"} onChange={(event) => setNoonaChat({enabled: event.target.value === "true"})}>
                <option value="true">Enabled</option>
                <option value="false">Disabled</option>
              </select>
            </label>
            <label>
              <span>Proposal mode</span>
              <select disabled={!canWrite} value={draft.noonaChat.proposalMode} onChange={(event) => setNoonaChat({proposalMode: event.target.value})}>
                <option value="conservative">Conservative</option>
                <option value="off">Off</option>
              </select>
            </label>
            <label>
              <span>Allowed channel ids</span>
              <textarea
                disabled={!canWrite}
                rows={4}
                placeholder="Empty means any guild channel"
                value={formatChannelIds(draft.noonaChat.allowedChannelIds)}
                onChange={(event) => setNoonaChat({allowedChannelIds: parseChannelIds(event.target.value)})}
              />
            </label>
          </div>
          <div className="admin-checkbox-grid">
            <label><input disabled={!canWrite} type="checkbox" checked={draft.noonaChat.memoryEnabled} onChange={(event) => setNoonaChat({memoryEnabled: event.target.checked})} /> Memory enabled</label>
            <label><input disabled type="checkbox" checked={draft.noonaChat.publicReplies} readOnly /> Public replies</label>
          </div>
          <div className="admin-detail-grid">
            <span><strong>Users remembered</strong>{noonaMemory.userCount || 0}</span>
            <span><strong>User facts</strong>{noonaMemory.userFactCount || 0}</span>
            <span><strong>Server lore</strong>{noonaMemory.serverFactCount || 0}</span>
            <span><strong>Last error</strong>{formatDisplayValue(runtime.lastNoonaMentionError, "none")}</span>
          </div>
          {normalizeArray(noonaMemory.serverFacts).length ? (
            <div className="admin-log-box">
              <div className="admin-kicker">Server lore</div>
              <p>{normalizeArray(noonaMemory.serverFacts).join("; ")}</p>
            </div>
          ) : null}
          <AdminDenseTable
            rows={noonaUsers}
            getKey={(row) => row.discordUserId}
            empty="No durable Noona memory has been saved yet."
            columns={[
              {key: "user", label: "User", render: (row) => (
                <span>
                  <strong>{formatDisplayValue(row.username, "Discord user")}</strong>
                  <br />
                  <span className="admin-muted">{formatDisplayValue(row.discordUserId, "unknown id")}</span>
                </span>
              )},
              {key: "facts", label: "Facts", render: (row) => `${row.factCount || 0}`},
              {key: "updated", label: "Updated", render: (row) => formatDate(row.updatedAt)},
              {key: "actions", label: "Actions", render: (row) => (
                <button
                  className="admin-button ghost"
                  type="button"
                  disabled={!canWrite || busy !== ""}
                  onClick={() => clearNoonaMemory("user", row.discordUserId)}
                >
                  Clear
                </button>
              )}
            ]}
          />
          <div className="admin-action-row">
            <button className="admin-button solid" type="button" disabled={!canWrite || busy !== ""} onClick={save}>Save settings</button>
            <button className="admin-button ghost" type="button" disabled={!canWrite || busy !== "" || !noonaMemory.serverFactCount} onClick={() => clearNoonaMemory("server")}>Clear server lore</button>
            <button className="admin-button ghost" type="button" disabled={!canWrite || busy !== "" || (!noonaMemory.userCount && !noonaMemory.serverFactCount)} onClick={() => clearNoonaMemory("all")}>Clear all memory</button>
          </div>
          <p className="admin-muted">Message Content intent must be enabled in the Discord developer portal for mentions and trivia guesses to arrive.</p>
        </article>

        <article className="admin-panel">
          <div className="admin-section-heading">
            <div>
              <div className="admin-kicker">Trivia</div>
              <h2>Noona title game</h2>
              <p className="admin-muted">Noona posts a sanitized summary clue, accepts public guesses, and awards XP to the first correct answer.</p>
            </div>
            <AdminStatusBadge tone={draft.trivia.enabled ? "good" : "queued"}>
              {draft.trivia.enabled ? "enabled" : "disabled"}
            </AdminStatusBadge>
          </div>
          <div className="admin-task-form">
            <label>
              <span>Enabled</span>
              <select disabled={!canWrite} value={draft.trivia.enabled ? "true" : "false"} onChange={(event) => setTrivia({enabled: event.target.value === "true"})}>
                <option value="true">Enabled</option>
                <option value="false">Disabled</option>
              </select>
            </label>
            <label>
              <span>Trivia channel id</span>
              <input disabled={!canWrite} value={draft.trivia.channelId} onChange={(event) => setTrivia({channelId: event.target.value})} />
            </label>
            <label>
              <span>Leaderboard channel id</span>
              <input disabled={!canWrite} value={draft.trivia.leaderboardChannelId} onChange={(event) => setTrivia({leaderboardChannelId: event.target.value})} placeholder="Defaults to trivia channel" />
            </label>
            <label>
              <span>Round minutes</span>
              <input disabled={!canWrite} type="number" min="1" max="240" value={draft.trivia.roundDurationMinutes} onChange={(event) => setTrivia({roundDurationMinutes: event.target.value})} />
            </label>
            <label>
              <span>Cooldown min</span>
              <input disabled={!canWrite} type="number" min="1" max="1440" value={draft.trivia.cooldownMinMinutes} onChange={(event) => setTrivia({cooldownMinMinutes: event.target.value})} />
            </label>
            <label>
              <span>Cooldown max</span>
              <input disabled={!canWrite} type="number" min="1" max="1440" value={draft.trivia.cooldownMaxMinutes} onChange={(event) => setTrivia({cooldownMaxMinutes: event.target.value})} />
            </label>
            <label>
              <span>Base XP</span>
              <input disabled={!canWrite} type="number" min="1" value={draft.trivia.baseXp} onChange={(event) => setTrivia({baseXp: event.target.value})} />
            </label>
            <label>
              <span>Speed bonus max</span>
              <input disabled={!canWrite} type="number" min="0" value={draft.trivia.speedBonusMax} onChange={(event) => setTrivia({speedBonusMax: event.target.value})} />
            </label>
            <label>
              <span>Streak bonus</span>
              <input disabled={!canWrite} type="number" min="0" value={draft.trivia.streakBonusPerWin} onChange={(event) => setTrivia({streakBonusPerWin: event.target.value})} />
            </label>
            <label>
              <span>Streak cap</span>
              <input disabled={!canWrite} type="number" min="0" value={draft.trivia.streakBonusMax} onChange={(event) => setTrivia({streakBonusMax: event.target.value})} />
            </label>
          </div>
          <div className="admin-checkbox-grid">
            <label><input disabled={!canWrite} type="checkbox" checked={draft.trivia.hintsEnabled} onChange={(event) => setTrivia({hintsEnabled: event.target.checked})} /> Timed hints</label>
            <label><input disabled={!canWrite} type="checkbox" checked={draft.trivia.aiMatchingEnabled} onChange={(event) => setTrivia({aiMatchingEnabled: event.target.checked})} /> AI borderline matching</label>
            <label><input disabled={!canWrite} type="checkbox" checked={draft.trivia.leaderboardAfterRound} onChange={(event) => setTrivia({leaderboardAfterRound: event.target.checked})} /> Post leaderboard after rounds</label>
          </div>
          <div className="admin-detail-grid">
            <span><strong>Current round</strong>{activeTriviaRound?.id ? formatDisplayValue(activeTriviaRound.status, "open") : "none"}</span>
            <span><strong>Answer</strong>{activeTriviaRound?.answerHidden ? "hidden" : formatDisplayValue(triviaAnswer, "unknown")}</span>
            <span><strong>Ends</strong>{activeTriviaRound?.expiresAt ? formatDate(activeTriviaRound.expiresAt) : "Unknown"}</span>
            <span><strong>Daily leader</strong>{formatDisplayValue(triviaRuntime.leaderboard?.rows?.[0]?.username, "none")}</span>
          </div>
          {latestTriviaRound?.prompt ? (
            <div className="admin-log-box">
              <div className="admin-kicker">Current clue</div>
              <p>{latestTriviaRound.prompt}</p>
            </div>
          ) : null}
          {canRevealTriviaAnswer && triviaAnswer ? (
            <div className="admin-action-row">
              {triviaAnswerUrl ? <a className="admin-button ghost" href={triviaAnswerUrl} target="_blank" rel="noreferrer">Open answer</a> : null}
              <button className="admin-button ghost" type="button" onClick={() => copyTriviaAnswer(triviaAnswer)}>
                {answerCopied ? "Copied" : "Copy answer"}
              </button>
            </div>
          ) : null}
          {activeTriviaRound?.answerHidden ? (
            <p className="admin-muted">Active answers are only revealed to owner or discord root admins.</p>
          ) : null}
          <AdminDenseTable
            rows={triviaGuesses}
            getKey={(row) => row.id}
            empty="No guesses recorded for the latest round."
            columns={[
              {key: "createdAt", label: "Time", render: (row) => formatDate(row.createdAt)},
              {key: "user", label: "User", render: (row) => formatDisplayValue(row.username, row.discordUserId)},
              {key: "guess", label: "Guess", render: (row) => row.redacted ? "hidden during active round" : formatDisplayValue(row.content, "blank")},
              {key: "result", label: "Result", render: (row) => (
                <AdminStatusBadge tone={row.correct ? "good" : row.close ? "warning" : ""}>
                  {row.correct ? "correct" : row.close ? "close" : "wrong"}
                </AdminStatusBadge>
              )},
              {key: "matchedBy", label: "Matched by", render: (row) => formatDisplayValue(row.matchedBy, "deterministic")}
            ]}
          />
          <div className="admin-action-row">
            <button className="admin-button solid" type="button" disabled={!canWrite || busy !== ""} onClick={save}>Save settings</button>
            <button className="admin-button ghost" type="button" disabled={!canWrite || busy !== "" || !draft.trivia.enabled || !draft.trivia.channelId} onClick={startTrivia}>Start round</button>
            <button className="admin-button ghost" type="button" disabled={!canWrite || busy !== ""} onClick={stopTrivia}>Stop round</button>
            <button className="admin-button ghost" type="button" disabled={!canWrite || busy !== "" || (!draft.trivia.channelId && !draft.trivia.leaderboardChannelId)} onClick={testLeaderboard}>Post leaderboard</button>
          </div>
          <p className="admin-muted">Schedules post at server time: daily 8 PM, weekly Sunday 8 PM, monthly first day 8 PM.</p>
        </article>

        <article className="admin-panel">
          <div className="admin-section-heading">
            <div>
              <div className="admin-kicker">Onboarding</div>
              <h2>Welcome message</h2>
            </div>
          </div>
          <div className="admin-task-form">
            <label>
              <span>Channel id</span>
              <input disabled={!canWrite} value={draft.onboarding.channelId} onChange={(event) => setOnboarding({channelId: event.target.value})} />
            </label>
            <label>
              <span>Template</span>
              <textarea disabled={!canWrite} rows={5} value={draft.onboarding.template} onChange={(event) => setOnboarding({template: event.target.value})} />
            </label>
          </div>
          <div className="admin-action-row">
            <button className="admin-button ghost" type="button" disabled={!canWrite || busy !== "" || !draft.onboarding.channelId} onClick={testOnboarding}>Send onboarding test</button>
          </div>
          <p className="admin-muted">Supported placeholders: {"{siteName}"}, {"{username}"}, {"{user_mention}"}, {"{guild_name}"}, {"{guild_id}"}, {"{moon_url}"}.</p>
        </article>
      </section>

      <section className="admin-panel">
        <div className="admin-section-heading">
          <div>
            <div className="admin-kicker">Commands</div>
            <h2>{commandRows.length} command{commandRows.length === 1 ? "" : "s"}</h2>
            <p className="admin-muted">Enable commands and assign required Discord role ids where the command supports role gates.</p>
          </div>
        </div>
        <AdminDenseTable
          rows={commandRows}
          getKey={(row) => row.id}
          columns={[
            {key: "enabled", label: "Enabled", render: (row) => (
              <input
                aria-label={`${row.label} enabled`}
                checked={row.enabled}
                disabled={!canWrite}
                type="checkbox"
                onChange={(event) => setCommand(row.id, {enabled: event.target.checked})}
              />
            )},
            {key: "command", label: "Command", render: (row) => (
              <span>
                <strong>{row.label}</strong>
                <br />
                <span className="admin-muted">{row.description}</span>
              </span>
            )},
            {key: "status", label: "Status", render: (row) => <AdminStatusBadge tone={row.registered ? "good" : "warning"}>{row.status}</AdminStatusBadge>},
            {key: "scope", label: "Scope", render: (row) => row.ownerOnly ? "owner DM" : row.scope},
            {key: "role", label: "Required role id", render: (row) => row.roleManaged ? (
              <input
                aria-label={`${row.label} role id`}
                disabled={!canWrite || !row.enabled}
                value={draft.commands[row.id]?.roleId || ""}
                onChange={(event) => setCommand(row.id, {roleId: event.target.value})}
                placeholder="Optional role id"
              />
            ) : "owner only"}
          ]}
        />
      </section>
    </>
  );
};

export default DiscordPage;
