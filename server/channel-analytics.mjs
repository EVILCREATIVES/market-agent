import { listDeliveryJobs } from "./delivery.mjs";
import { getSocialAnalyticsAccess, SOCIAL_PROVIDERS } from "./social-connections.mjs";
import { getPool } from "./db.mjs";

let metricSnapshotsReady = false;

const CHANNEL_LABELS = {
  linkedin: "LinkedIn",
  instagram: "Instagram",
  tiktok: "TikTok",
  youtube: "YouTube",
  x: "X",
  discord: "Discord",
  reddit: "Reddit",
};

const METRIC_LABELS = {
  views: "Views",
  reach: "Reach",
  impressions: "Impressions",
  likes: "Likes",
  reactions: "Reactions",
  comments: "Comments",
  shares: "Shares",
  saves: "Saves",
  score: "Score",
};

export async function getChannelAnalytics(userId, projectId, provider, range = "28daysAgo", env = process.env) {
  if (!SOCIAL_PROVIDERS.includes(provider)) throw channelAnalyticsError("Choose a supported social channel.", 400);
  const normalizedRange = /^(7|14|28|30|60|90)daysAgo$/.test(String(range)) ? String(range) : "28daysAgo";
  const days = Number(normalizedRange.match(/^\d+/)?.[0] || 28);
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const { jobs } = await listDeliveryJobs(userId, projectId, "", env);
  const channelJobs = jobs
    .filter((job) => job.channel === provider && new Date(job.createdAt).getTime() >= cutoff)
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
  const publishedJobs = channelJobs.filter((job) => job.status === "complete");
  const posts = publishedJobs.slice(0, 25).map((job) => deliveryPost(provider, job));
  const access = await getSocialAnalyticsAccess(userId, projectId, provider, env);
  const base = {
    provider,
    label: CHANNEL_LABELS[provider] || provider,
    range: normalizedRange,
    connected: Boolean(access),
    accountLabel: access?.accountLabel || "",
    availability: access ? "delivery_only" : "not_connected",
    note: access ? "Delivery history is live. This channel has not returned engagement metrics yet." : `Connect ${CHANNEL_LABELS[provider] || provider} to read live channel statistics.`,
    requiredAction: access ? "" : `Connect ${CHANNEL_LABELS[provider] || provider} in Integrations.`,
    totals: {
      published: publishedJobs.length,
      failed: channelJobs.filter((job) => job.status === "failed").length,
      pending: channelJobs.filter((job) => ["awaiting_approval", "running", "submitted"].includes(job.status)).length,
    },
    comparison: null,
    account: {},
    metrics: [],
    posts,
    geography: {
      availability: access ? "not_provided" : "not_connected",
      metric: "views",
      metricLabel: "Views",
      locations: [],
      note: access
        ? `${CHANNEL_LABELS[provider] || provider} does not provide usable audience-location data through the currently approved connection.`
        : `Connect ${CHANNEL_LABELS[provider] || provider} to check whether location reporting is available.`,
    },
    fetchedAt: new Date().toISOString(),
  };
  if (!access) return base;
  try {
    const live = provider === "instagram"
      ? await readInstagram(access, posts, env, { cutoff, days })
      : provider === "youtube"
        ? await readYouTube(access, posts, { cutoff })
        : provider === "tiktok"
          ? await readTikTok(access, posts)
          : provider === "x"
            ? await readX(access, posts)
            : provider === "linkedin"
              ? await readLinkedIn(access, posts, env)
              : provider === "discord"
                ? await readDiscord(access, posts)
                : await readReddit(access, posts, env);
    const mergedPosts = posts.map((post) => ({ ...post, ...(live.postsById?.[post.providerId] || {}) }));
    const measuredPosts = Array.isArray(live.posts) ? live.posts : mergedPosts;
    const metricKeys = Array.from(new Set(live.metricKeys || []));
    const totals = { ...base.totals };
    if (Number.isFinite(live.publishedCount)) totals.published = Number(live.publishedCount);
    for (const key of metricKeys) totals[key] = knownMetricTotal(measuredPosts, key);
    const report = {
      ...base,
      availability: live.availability || (metricKeys.length ? "live" : "delivery_only"),
      note: live.note || base.note,
      requiredAction: live.requiredAction || "",
      totals,
      account: live.account || {},
      metrics: metricKeys.map((key) => ({ key, label: METRIC_LABELS[key] || titleCase(key) })),
      posts: measuredPosts,
      geography: live.geography || base.geography,
    };
    await persistDeliveryPerformance(userId, projectId, provider, measuredPosts, env);
    report.comparison = await recordAndCompareChannelSnapshot(userId, projectId, provider, report, cutoff, env);
    return report;
  } catch (error) {
    return {
      ...base,
      availability: Number(error?.statusCode || 0) === 403 ? "permission_required" : "temporarily_unavailable",
      note: safeProviderMessage(error, `${CHANNEL_LABELS[provider] || provider} statistics could not be refreshed.`),
      requiredAction: Number(error?.statusCode || 0) === 401 ? `Reconnect ${CHANNEL_LABELS[provider] || provider}.` : "Try refreshing this tab later.",
    };
  }
}

async function persistDeliveryPerformance(userId, projectId, provider, posts, env) {
  const measured = (Array.isArray(posts) ? posts : []).filter((post) => post?.providerId && Object.keys(post.metrics || {}).length);
  if (!measured.length) return;
  await Promise.all(measured.slice(0, 50).map((post) => getPool(env).query(
    `UPDATE market_agent_delivery_jobs
      SET result = COALESCE(result, '{}'::jsonb) || jsonb_build_object(
        'performance', $5::jsonb,
        'performanceUpdatedAt', NOW(),
        'publicUrl', $6::text
      ), updated_at = NOW()
      WHERE user_id = $1 AND project_id = $2 AND channel = $3
        AND external_id = $4 AND external_id <> ''`,
    [userId, projectId, provider, String(post.providerId), JSON.stringify(post.metrics || {}), String(post.url || "")],
  ).catch(() => undefined)));
}

async function recordAndCompareChannelSnapshot(userId, projectId, provider, report, cutoff, env) {
  if (!env.DATABASE_URL) return null;
  try {
    await ensureMetricSnapshotsTable(env);
    const pool = getPool(env);
    const baselineResult = await pool.query(
      `SELECT captured_at, account
         FROM market_agent_metric_snapshots
        WHERE user_id = $1 AND project_id = $2 AND provider = $3
          AND captured_at < date_trunc('day', NOW())
        ORDER BY ABS(EXTRACT(EPOCH FROM (captured_at - to_timestamp($4)))) ASC
        LIMIT 1`,
      [userId, projectId, provider, Math.floor(cutoff / 1000)],
    );
    const account = numericObject(report.account);
    const totals = numericObject(report.totals);
    await pool.query(
      `INSERT INTO market_agent_metric_snapshots
        (user_id, project_id, provider, captured_on, captured_at, account, totals)
       VALUES ($1,$2,$3,CURRENT_DATE,NOW(),$4::jsonb,$5::jsonb)
       ON CONFLICT (user_id, project_id, provider, captured_on) DO UPDATE SET
         captured_at = NOW(), account = EXCLUDED.account, totals = EXCLUDED.totals`,
      [userId, projectId, provider, JSON.stringify(account), JSON.stringify(totals)],
    );
    const baseline = baselineResult.rows[0];
    if (!baseline) return null;
    const previousAccount = numericObject(baseline.account);
    const metrics = {};
    for (const [key, current] of Object.entries(account)) {
      const previous = previousAccount[key];
      if (!Number.isFinite(current) || !Number.isFinite(previous)) continue;
      const absolute = current - previous;
      metrics[key] = { current, previous, absolute, percent: previous === 0 ? null : (absolute / previous) * 100 };
    }
    if (!Object.keys(metrics).length) return null;
    const baselineAt = new Date(baseline.captured_at).toISOString();
    return { baselineAt, label: `Since ${new Date(baselineAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`, metrics };
  } catch {
    return null;
  }
}

async function ensureMetricSnapshotsTable(env) {
  if (metricSnapshotsReady) return;
  await getPool(env).query(`
    CREATE TABLE IF NOT EXISTS market_agent_metric_snapshots (
      user_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      captured_on DATE NOT NULL,
      captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      account JSONB NOT NULL DEFAULT '{}'::jsonb,
      totals JSONB NOT NULL DEFAULT '{}'::jsonb,
      PRIMARY KEY (user_id, project_id, provider, captured_on)
    );
    CREATE INDEX IF NOT EXISTS market_agent_metric_snapshots_lookup_idx
      ON market_agent_metric_snapshots (user_id, project_id, provider, captured_at DESC);
  `);
  metricSnapshotsReady = true;
}

function numericObject(value) {
  return Object.fromEntries(Object.entries(value || {}).flatMap(([key, item]) => {
    const numeric = optionalNumber(item);
    return numeric == null ? [] : [[key, numeric]];
  }));
}

function deliveryPost(provider, job) {
  const result = job.result || {};
  const publicIds = provider === "tiktok" && Array.isArray(result.publicPostIds) ? result.publicPostIds.map(String).filter(Boolean) : [];
  const providerId = publicIds[0] || String(job.externalId || "");
  const text = String(job.payload?.subject || job.payload?.text || "").trim();
  return {
    id: job.id,
    providerId,
    title: text ? text.slice(0, 120) : `${CHANNEL_LABELS[provider] || provider} publication`,
    publishedAt: job.completedAt || job.updatedAt || job.createdAt,
    status: job.status,
    url: String(result.url || providerPostUrl(provider, providerId)),
    metrics: {},
  };
}

async function readInstagram(access, deliveryPosts, env, { cutoff, days }) {
  const version = env.INSTAGRAM_GRAPH_VERSION || "v27.0";
  const accountId = String(access.credentials?.destinationId || access.accountId || "");
  if (!/^\d+$/.test(accountId)) throw channelAnalyticsError("Choose the Instagram professional account for this project before reading analytics.", 409);
  const accountUrl = graphUrl(version, accountId, "id,username,followers_count,follows_count,media_count", access.accessToken);
  const accountResponse = await providerJson(accountUrl, {}, "Instagram account statistics are unavailable.");
  const grantedPermissions = await readInstagramPermissions(version, access.accessToken);
  const insightsAllowed = grantedPermissions.includes("instagram_manage_insights") || access.scopes.includes("instagram_manage_insights");
  const media = await readInstagramMedia(version, accountId, access.accessToken, cutoff);
  const deliveryByProviderId = new Map(deliveryPosts.filter((post) => post.providerId).map((post) => [post.providerId, post]));
  const livePosts = media.map((item) => {
    const receipt = deliveryByProviderId.get(String(item.id || ""));
    return {
      id: receipt?.id || `instagram-${String(item.id || crypto.randomUUID())}`,
      providerId: String(item.id || ""),
      title: String(item.caption || `${instagramMediaLabel(item)} published on Instagram`).slice(0, 120),
      publishedAt: String(item.timestamp || receipt?.publishedAt || ""),
      status: receipt?.status || "live",
      url: String(item.permalink || receipt?.url || ""),
      metrics: compactMetrics({
        views: optionalNumber(item.total_views_count ?? item.view_count),
        likes: optionalNumber(item.total_like_count ?? item.like_count),
        comments: optionalNumber(item.total_comments_count ?? item.comments_count),
        shares: optionalNumber(item.shares_count),
        saves: optionalNumber(item.saved_count),
      }),
    };
  });
  await Promise.all(livePosts.slice(0, 25).map(async (post) => {
    if (!insightsAllowed || !/^\d+$/.test(post.providerId)) return;
    try {
      const insightUrl = new URL(`https://graph.facebook.com/${version}/${encodeURIComponent(post.providerId)}/insights`);
      insightUrl.searchParams.set("metric", "reach,saved,shares,total_interactions,views");
      insightUrl.searchParams.set("access_token", access.accessToken);
      const insightData = await providerJson(insightUrl, {}, "Instagram insights are unavailable.");
      for (const item of insightData.data || []) {
        const value = item.total_value?.value ?? item.values?.at(-1)?.value;
        const numeric = optionalNumber(value);
        if (numeric == null) continue;
        if (item.name === "saved") post.metrics.saves = numeric;
        else if (item.name === "shares") post.metrics.shares = numeric;
        else if (item.name === "reach") post.metrics.reach = numeric;
        else if (item.name === "views") post.metrics.views = numeric;
      }
    } catch {
      // Public owner metrics remain valid when a media type does not expose every insight.
    }
  }));
  const metricKeys = ["views", "reach", "likes", "comments", "shares", "saves"].filter((key) => livePosts.some((post) => post.metrics?.[key] != null));
  return {
    availability: "live",
    account: {
      username: accountResponse.username ? `@${accountResponse.username}` : access.accountLabel,
      ...compactMetrics({
        followers: optionalNumber(accountResponse.followers_count),
        following: optionalNumber(accountResponse.follows_count),
        media: optionalNumber(accountResponse.media_count),
      }),
    },
    metricKeys,
    posts: livePosts,
    publishedCount: livePosts.length,
    note: `Live data from ${accountResponse.username ? `@${accountResponse.username}` : "the connected professional account"} for the last ${days} days. This includes all account media in the period, not only posts published by Market Agent.`,
    requiredAction: insightsAllowed ? "" : "Reach and any unavailable owner-only metrics require Instagram insights permission in Meta, followed by reconnection.",
  };
}

async function readInstagramPermissions(version, accessToken) {
  try {
    const url = new URL(`https://graph.facebook.com/${version}/me/permissions`);
    url.searchParams.set("access_token", accessToken);
    const permissions = await providerJson(url, {}, "Instagram permissions are unavailable.");
    return (permissions.data || [])
      .filter((item) => item?.status === "granted")
      .map((item) => String(item.permission || ""))
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function readInstagramMedia(version, accountId, accessToken, cutoff) {
  const extendedFields = "id,media_type,media_product_type,permalink,timestamp,caption,like_count,comments_count,saved_count,shares_count,total_like_count,total_comments_count,total_views_count";
  const baseFields = "id,media_type,media_product_type,permalink,timestamp,caption,like_count,comments_count";
  try {
    return await readInstagramMediaPages(version, accountId, accessToken, cutoff, extendedFields);
  } catch {
    // Meta exposes a different set of direct media fields across Instagram login products.
    // Retry with the common fields and leave every unsupported metric unavailable.
    return readInstagramMediaPages(version, accountId, accessToken, cutoff, baseFields);
  }
}

async function readInstagramMediaPages(version, accountId, accessToken, cutoff, fields) {
  let url = new URL(`https://graph.facebook.com/${version}/${encodeURIComponent(accountId)}/media`);
  url.searchParams.set("fields", fields);
  url.searchParams.set("access_token", accessToken);
  url.searchParams.set("limit", "100");
  const media = [];
  for (let page = 0; page < 3 && url; page += 1) {
    const response = await providerJson(url, {}, "Instagram media statistics are unavailable.");
    const items = Array.isArray(response.data) ? response.data : [];
    for (const item of items) {
      const publishedAt = new Date(item.timestamp || 0).getTime();
      if (Number.isFinite(publishedAt) && publishedAt >= cutoff) media.push(item);
    }
    const oldest = items.reduce((value, item) => Math.min(value, new Date(item.timestamp || 0).getTime() || value), Number.POSITIVE_INFINITY);
    if (!response.paging?.next || oldest < cutoff) break;
    url = new URL(response.paging.next);
  }
  return media.sort((left, right) => new Date(right.timestamp || 0).getTime() - new Date(left.timestamp || 0).getTime());
}

function instagramMediaLabel(media) {
  if (media?.media_product_type === "REELS") return "Reel";
  if (media?.media_type === "CAROUSEL_ALBUM") return "Carousel";
  if (media?.media_type === "VIDEO") return "Video";
  return "Post";
}

async function readYouTube(access, posts, { cutoff }) {
  const ids = posts.map((post) => post.providerId).filter(Boolean).slice(0, 50);
  const channelUrl = new URL("https://www.googleapis.com/youtube/v3/channels");
  channelUrl.search = new URLSearchParams({ part: "snippet,statistics", id: access.accountId }).toString();
  const channelData = await providerJson(channelUrl, { headers: bearer(access.accessToken) }, "YouTube channel statistics are unavailable.");
  const channel = channelData.items?.[0] || {};
  const postsById = {};
  if (ids.length) {
    const videosUrl = new URL("https://www.googleapis.com/youtube/v3/videos");
    videosUrl.search = new URLSearchParams({ part: "snippet,statistics", id: ids.join(",") }).toString();
    const videos = await providerJson(videosUrl, { headers: bearer(access.accessToken) }, "YouTube video statistics are unavailable.");
    for (const video of videos.items || []) postsById[String(video.id)] = {
      title: String(video.snippet?.title || "YouTube video"),
      url: `https://www.youtube.com/watch?v=${encodeURIComponent(String(video.id))}`,
      metrics: {
        views: numberValue(video.statistics?.viewCount),
        likes: numberValue(video.statistics?.likeCount),
        comments: numberValue(video.statistics?.commentCount),
      },
    };
  }
  const geographyUrl = new URL("https://youtubeanalytics.googleapis.com/v2/reports");
  geographyUrl.search = new URLSearchParams({
    ids: "channel==MINE",
    startDate: new Date(cutoff).toISOString().slice(0, 10),
    endDate: new Date().toISOString().slice(0, 10),
    metrics: "views,estimatedMinutesWatched",
    dimensions: "country",
    sort: "-views",
    maxResults: "200",
  }).toString();
  let geography = { availability: "insufficient_data", metric: "views", metricLabel: "Views", locations: [], note: "YouTube has not returned enough location data for this period." };
  try {
    const data = await providerJson(geographyUrl, { headers: bearer(access.accessToken) }, "YouTube audience locations are unavailable.");
    const headers = (data.columnHeaders || []).map((header) => String(header.name || ""));
    const rows = (data.rows || []).map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index]])));
    const locations = rows.map((row) => ({
      countryCode: String(row.country || "").toUpperCase(),
      country: countryName(row.country),
      region: "",
      city: "",
      value: numberValue(row.views),
      secondaryValue: numberValue(row.estimatedMinutesWatched),
      conversions: 0,
    })).filter((location) => location.countryCode && location.value > 0);
    geography = {
      availability: locations.length ? "live" : "insufficient_data",
      metric: "views",
      metricLabel: "Views",
      locations,
      note: locations.length ? "Viewer countries reported by the connected YouTube channel." : geography.note,
    };
  } catch {
    // Channel and publication metrics remain valid when geography is thresholded or unavailable.
  }
  return {
    availability: "live",
    account: {
      channel: String(channel.snippet?.title || access.accountLabel),
      subscribers: numberValue(channel.statistics?.subscriberCount),
      views: numberValue(channel.statistics?.viewCount),
      videos: numberValue(channel.statistics?.videoCount),
    },
    metricKeys: ["views", "likes", "comments"],
    postsById,
    geography,
    note: "Live channel and video statistics from YouTube.",
  };
}

async function readTikTok(access, posts) {
  if (!access.scopes.includes("video.list")) return {
    availability: "permission_required",
    metricKeys: [],
    postsById: {},
    note: "Published-delivery history is live. TikTok engagement statistics require the video.list permission.",
    requiredAction: "Approve TikTok Display API access and reconnect the account.",
  };
  const ids = posts.map((post) => post.providerId).filter((id) => /^\d+$/.test(id)).slice(0, 20);
  const postsById = {};
  if (ids.length) {
    const url = "https://open.tiktokapis.com/v2/video/query/?fields=id,title,video_description,share_url,create_time,view_count,like_count,comment_count,share_count";
    const response = await providerJson(url, {
      method: "POST",
      headers: { ...bearer(access.accessToken), "Content-Type": "application/json" },
      body: JSON.stringify({ filters: { video_ids: ids } }),
    }, "TikTok video statistics are unavailable.");
    for (const video of response.data?.videos || []) postsById[String(video.id)] = {
      title: String(video.title || video.video_description || "TikTok video").slice(0, 120),
      url: String(video.share_url || ""),
      metrics: {
        views: numberValue(video.view_count),
        likes: numberValue(video.like_count),
        comments: numberValue(video.comment_count),
        shares: numberValue(video.share_count),
      },
    };
  }
  return { availability: "live", metricKeys: ["views", "likes", "comments", "shares"], postsById, note: "Live statistics for authorized TikTok videos." };
}

async function readX(access, posts) {
  const ids = posts.map((post) => post.providerId).filter((id) => /^\d+$/.test(id)).slice(0, 100);
  const postsById = {};
  if (ids.length) {
    const url = new URL("https://api.x.com/2/tweets");
    url.search = new URLSearchParams({ ids: ids.join(","), "tweet.fields": "created_at,public_metrics" }).toString();
    const data = await providerJson(url, { headers: bearer(access.accessToken) }, "X post statistics are unavailable.");
    for (const post of data.data || []) postsById[String(post.id)] = {
      url: `https://x.com/i/web/status/${encodeURIComponent(String(post.id))}`,
      title: String(post.text || "X post").slice(0, 120),
      metrics: {
        impressions: numberValue(post.public_metrics?.impression_count),
        likes: numberValue(post.public_metrics?.like_count),
        comments: numberValue(post.public_metrics?.reply_count),
        shares: numberValue(post.public_metrics?.retweet_count) + numberValue(post.public_metrics?.quote_count),
      },
    };
  }
  const userUrl = new URL(`https://api.x.com/2/users/${encodeURIComponent(access.accountId)}`);
  userUrl.searchParams.set("user.fields", "public_metrics,username,name");
  const userData = await providerJson(userUrl, { headers: bearer(access.accessToken) }, "X account statistics are unavailable.");
  return {
    availability: "live",
    account: {
      username: userData.data?.username ? `@${userData.data.username}` : access.accountLabel,
      followers: numberValue(userData.data?.public_metrics?.followers_count),
      following: numberValue(userData.data?.public_metrics?.following_count),
      posts: numberValue(userData.data?.public_metrics?.tweet_count),
    },
    metricKeys: ["impressions", "likes", "comments", "shares"],
    postsById,
    note: "Live public account and post metrics from X. Opening this tab makes X API requests.",
  };
}

async function readLinkedIn(access, posts, env) {
  const readable = access.scopes.some((scope) => ["r_organization_social", "r_organization_social_feed", "r_member_social", "r_member_social_feed"].includes(scope));
  if (!readable) return {
    availability: "permission_required",
    metricKeys: [],
    postsById: {},
    note: "Publishing receipts are live. LinkedIn reactions and comments require approved Community Management read access.",
    requiredAction: "Complete LinkedIn Community Management approval and reconnect the account.",
  };
  const postsById = {};
  await Promise.all(posts.filter((post) => post.providerId.startsWith("urn:li:")).slice(0, 15).map(async (post) => {
    try {
      const data = await providerJson(`https://api.linkedin.com/rest/socialMetadata/${encodeURIComponent(post.providerId)}`, {
        headers: { ...bearer(access.accessToken), "Linkedin-Version": env.LINKEDIN_VERSION || "202609", "X-Restli-Protocol-Version": "2.0.0" },
      }, "LinkedIn post statistics are unavailable.");
      const reactions = Object.values(data.reactionSummaries || {}).reduce((sum, item) => sum + numberValue(item?.count), 0);
      postsById[post.providerId] = { metrics: { reactions, comments: numberValue(data.commentSummary?.count) } };
    } catch {
      // Preserve delivery history if a personal post is outside the approved read scope.
    }
  }));
  return { availability: "live", metricKeys: ["reactions", "comments"], postsById, note: "Live reactions and comments for posts covered by the approved LinkedIn read scope." };
}

async function readDiscord(access, posts) {
  const webhookId = String(access.credentials?.webhookId || "");
  const webhookToken = String(access.credentials?.webhookToken || "");
  if (!webhookId || !webhookToken) throw channelAnalyticsError("Reconnect Discord to read message activity.", 401);
  const postsById = {};
  await Promise.all(posts.filter((post) => /^\d+$/.test(post.providerId)).slice(0, 15).map(async (post) => {
    try {
      const data = await providerJson(`https://discord.com/api/v10/webhooks/${encodeURIComponent(webhookId)}/${encodeURIComponent(webhookToken)}/messages/${encodeURIComponent(post.providerId)}`, {}, "Discord message activity is unavailable.");
      postsById[post.providerId] = { metrics: { reactions: (data.reactions || []).reduce((sum, reaction) => sum + numberValue(reaction.count), 0) } };
    } catch {
      // Delivery remains verified even if a webhook message was deleted or is no longer readable.
    }
  }));
  return { availability: "live", metricKeys: ["reactions"], postsById, note: "Live reaction counts for messages delivered through the connected Discord webhook. Discord does not expose reach or impressions for webhook posts." };
}

async function readReddit(access, posts, env) {
  const ids = posts.map((post) => post.providerId).filter(Boolean).map((id) => id.startsWith("t3_") ? id : `t3_${id}`).slice(0, 25);
  const postsById = {};
  if (ids.length) {
    const url = new URL("https://oauth.reddit.com/api/info");
    url.searchParams.set("id", ids.join(","));
    const data = await providerJson(url, { headers: { ...bearer(access.accessToken), "User-Agent": String(env.REDDIT_USER_AGENT || "web:market-agent:1.0.0") } }, "Reddit post statistics are unavailable.");
    for (const child of data.data?.children || []) {
      const post = child.data || {};
      const id = String(post.name || post.id || "");
      const metrics = { score: numberValue(post.score), comments: numberValue(post.num_comments) };
      postsById[id] = { title: String(post.title || "Reddit post").slice(0, 120), url: post.permalink ? `https://www.reddit.com${post.permalink}` : "", metrics };
      if (id.startsWith("t3_")) postsById[id.slice(3)] = postsById[id];
    }
  }
  return { availability: "live", metricKeys: ["score", "comments"], postsById, note: "Live score and comment counts for authorized Reddit posts." };
}

function graphUrl(version, id, fields, accessToken) {
  const url = new URL(`https://graph.facebook.com/${version}/${encodeURIComponent(id)}`);
  url.searchParams.set("fields", fields);
  url.searchParams.set("access_token", accessToken);
  return url;
}

function providerPostUrl(provider, id) {
  if (!id) return "";
  if (provider === "youtube") return `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;
  if (provider === "x") return `https://x.com/i/web/status/${encodeURIComponent(id)}`;
  if (provider === "linkedin") return `https://www.linkedin.com/feed/update/${encodeURIComponent(id)}/`;
  return "";
}

async function providerJson(url, options, fallback) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || (data.error?.code && ![0, "ok"].includes(data.error.code))) {
    const error = channelAnalyticsError(String(data.error?.message || data.message || fallback), response.status === 401 ? 401 : response.status === 403 ? 403 : 502);
    throw error;
  }
  return data;
}

function bearer(token) {
  return { Authorization: `Bearer ${token}` };
}

function numberValue(value) {
  const numeric = Number(value || 0);
  return Number.isFinite(numeric) ? numeric : 0;
}

function optionalNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function compactMetrics(values) {
  return Object.fromEntries(Object.entries(values || {}).filter(([, value]) => value !== null && value !== undefined));
}

function knownMetricTotal(posts, key) {
  const values = (posts || []).map((post) => optionalNumber(post.metrics?.[key])).filter((value) => value !== null);
  return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
}

function titleCase(value) {
  return String(value || "").replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function countryName(code) {
  const normalized = String(code || "").toUpperCase();
  if (!normalized) return "";
  try { return new Intl.DisplayNames(["en"], { type: "region" }).of(normalized) || normalized; }
  catch { return normalized; }
}

function safeProviderMessage(error, fallback) {
  const message = String(error?.message || "").replace(/access[_ -]?token|client[_ -]?secret|webhook[_ -]?token/gi, "credential").slice(0, 300);
  return message || fallback;
}

function channelAnalyticsError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
