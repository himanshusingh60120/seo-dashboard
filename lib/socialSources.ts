// lib/socialSources.ts
// Which GA4 session sources are social networks, and their display names. Shared by /api/ga4/social and the dashboard.
// A session counts as social when GA4 puts it in the Organic Social or Paid Social channel, OR its source matches
// SOCIAL_SOURCE_PATTERN (LinkedIn often arrives as "linkedin.com / referral" or "lnkd.in", which GA4 files as Referral).

export const SOCIAL_CHANNELS = ["Organic Social", "Paid Social"];

/** GA4 regular expression (RE2), matched anywhere in sessionSource, case-insensitive. Short names such as t.co, fb and ig
 *  aren't in it (they'd match unrelated sites); GA4 already puts those in the Organic Social channel. */
export const SOCIAL_SOURCE_PATTERN =
  "linkedin|lnkd\\.in|facebook|instagram|twitter|youtube|youtu\\.be|reddit|pinterest|quora|tiktok|whatsapp|telegram|threads\\.net|snapchat|discord";

const NETWORKS: [RegExp, string][] = [
  [/linkedin|lnkd\.in/i, "LinkedIn"],
  [/facebook|^fb$|^fb\.com$|^fb\.me$/i, "Facebook"],
  [/instagram|^ig$/i, "Instagram"],
  [/twitter|^t\.co$|^x\.com$|^x$/i, "X (Twitter)"],
  [/youtube|youtu\.be/i, "YouTube"],
  [/reddit/i, "Reddit"],
  [/pinterest|^pin\.it$/i, "Pinterest"],
  [/quora/i, "Quora"],
  [/tiktok/i, "TikTok"],
  [/whatsapp|^wa\.me$/i, "WhatsApp"],
  [/telegram|^t\.me$/i, "Telegram"],
  [/threads\.net|^threads$/i, "Threads"],
  [/snapchat/i, "Snapchat"],
  [/discord/i, "Discord"],
];

/** "lnkd.in" → "LinkedIn", "m.facebook.com" → "Facebook". Social sources not in the list → "Other social". */
export const networkOf = (source: string) => {
  const s = (source || "").trim().toLowerCase();
  return NETWORKS.find(([re]) => re.test(s))?.[1] || "Other social";
};

export const SOCIAL_NETWORK_LIST =
  "LinkedIn, Facebook, Instagram, X (Twitter), YouTube, Reddit, Pinterest, Quora, TikTok, WhatsApp, Telegram, Threads, Snapchat and Discord";
