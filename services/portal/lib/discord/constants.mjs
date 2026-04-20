export const EPHEMERAL_FLAG = 64;
export const MAX_VISIBLE_RESULTS = 5;
export const REQUEST_SESSION_TTL_MS = 10 * 60 * 1000;
export const FOLLOW_NOTIFICATION_POLL_MS = 30 * 1000;

export const DOWNLOAD_ALL_PATTERN = /^(?:\/|!)?downloadall\b/i;
export const DOWNLOAD_ALL_TOKEN_PATTERN = /([a-z]+):(?:"([^"]*)"|'([^']*)'|(\S+))/gi;
export const DOWNLOAD_ALL_ALLOWED_KEYS = new Set(["type", "nsfw", "titlegroup"]);
export const DOWNLOAD_ALL_TYPE_ALIASES = Object.freeze(new Map([
  ["manga", "Manga"],
  ["managa", "Manga"],
  ["manhwa", "Manhwa"],
  ["manhua", "Manhua"],
  ["oel", "OEL"]
]));
