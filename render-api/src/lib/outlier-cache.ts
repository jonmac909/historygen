/**
 * Outlier Cache - Supabase caching layer for TubeLab/YouTube API responses
 * Reduces API costs by storing and reusing channel/outlier data
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';

// Initialize Supabase client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

let supabase: SupabaseClient | null = null;

function getSupabase(): SupabaseClient {
  if (!supabase) {
    if (!supabaseUrl || !supabaseKey) {
      throw new Error('Supabase credentials not configured');
    }
    supabase = createClient(supabaseUrl, supabaseKey);
  }
  return supabase;
}

// ==================== Types ====================

export interface CachedChannel {
  id: string;
  title: string;
  handle?: string;
  thumbnail_url: string;
  subscriber_count: number;
  view_count: number;
  video_count: number;
  views_to_subs_ratio: number;
  avg_views: number;
  is_breakout: boolean;
  created_at?: string;
  monetization?: {
    adsense?: boolean;
    rpmEstimationFrom?: number;
    rpmEstimationTo?: number;
  };
  source: 'tubelab' | 'youtube' | 'apify';
  fetched_at: string;
  expires_at: string;
}

export interface CachedOutlier {
  video_id: string;
  channel_id: string;
  title: string;
  thumbnail_url: string;
  published_at: string;
  duration_seconds: number;
  view_count: number;
  like_count: number;
  comment_count: number;
  outlier_multiplier: number;
  z_score: number;
  views_per_subscriber: number;
  is_positive_outlier: boolean;
  is_negative_outlier: boolean;
  monetization?: {
    rpmEstimationFrom?: number;
    rpmEstimationTo?: number;
    revenueEstimationFrom?: number;
    revenueEstimationTo?: number;
  };
  classification?: {
    isFaceless?: boolean;
    quality?: 'negative' | 'neutral' | 'positive';
  };
  source: 'tubelab' | 'youtube' | 'apify' | 'scraper';
  fetched_at: string;
  expires_at: string;
}

export interface CachedNicheSearch {
  topic: string;
  channel_ids: string[];
  metrics: {
    channelCount: number;
    avgSubscribers: number;
    avgViewsPerVideo: number;
    avgViewsToSubsRatio: number;
    saturationLevel: 'low' | 'medium' | 'high';
    saturationScore: number;
  };
  total_in_database: number;
  source: 'tubelab' | 'youtube';
  fetched_at: string;
  expires_at: string;
}

// ==================== Channel Cache ====================

export async function getCachedChannel(channelId: string): Promise<CachedChannel | null> {
  try {
    const { data, error } = await getSupabase()
      .from('cached_channels')
      .select('*')
      .eq('id', channelId)
      .gt('expires_at', new Date().toISOString())
      .single();

    if (error || !data) return null;
    return data as CachedChannel;
  } catch (e) {
    console.error('[outlier-cache] Error getting cached channel:', e);
    return null;
  }
}

export async function getCachedChannels(channelIds: string[]): Promise<CachedChannel[]> {
  if (channelIds.length === 0) return [];

  try {
    const { data, error } = await getSupabase()
      .from('cached_channels')
      .select('*')
      .in('id', channelIds)
      .gt('expires_at', new Date().toISOString());

    if (error || !data) return [];
    return data as CachedChannel[];
  } catch (e) {
    console.error('[outlier-cache] Error getting cached channels:', e);
    return [];
  }
}

export async function cacheChannel(channel: Omit<CachedChannel, 'fetched_at' | 'expires_at'>): Promise<void> {
  try {
    const now = new Date();
    const expires = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // 7 days

    await getSupabase()
      .from('cached_channels')
      .upsert({
        ...channel,
        fetched_at: now.toISOString(),
        expires_at: expires.toISOString(),
      }, { onConflict: 'id' });

    console.log(`[outlier-cache] Cached channel: ${channel.id}`);
  } catch (e) {
    console.error('[outlier-cache] Error caching channel:', e);
  }
}

export async function cacheChannels(channels: Omit<CachedChannel, 'fetched_at' | 'expires_at'>[]): Promise<void> {
  if (channels.length === 0) return;

  try {
    const now = new Date();
    const expires = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // 7 days

    const records = channels.map(ch => ({
      ...ch,
      fetched_at: now.toISOString(),
      expires_at: expires.toISOString(),
    }));

    await getSupabase()
      .from('cached_channels')
      .upsert(records, { onConflict: 'id' });

    console.log(`[outlier-cache] Cached ${channels.length} channels`);
  } catch (e) {
    console.error('[outlier-cache] Error caching channels:', e);
  }
}

// ==================== Outlier Cache ====================

export async function getCachedOutliersForChannel(channelId: string): Promise<CachedOutlier[]> {
  try {
    const { data, error } = await getSupabase()
      .from('cached_outliers')
      .select('*')
      .eq('channel_id', channelId)
      .gt('expires_at', new Date().toISOString())
      .order('outlier_multiplier', { ascending: false });

    if (error || !data) return [];
    return data as CachedOutlier[];
  } catch (e) {
    console.error('[outlier-cache] Error getting cached outliers:', e);
    return [];
  }
}

export async function cacheOutliers(outliers: Omit<CachedOutlier, 'fetched_at' | 'expires_at'>[]): Promise<void> {
  if (outliers.length === 0) return;

  try {
    const now = new Date();
    const expires = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // 7 days

    const records = outliers.map(o => ({
      ...o,
      fetched_at: now.toISOString(),
      expires_at: expires.toISOString(),
    }));

    await getSupabase()
      .from('cached_outliers')
      .upsert(records, { onConflict: 'video_id' });

    console.log(`[outlier-cache] Cached ${outliers.length} outliers for channel ${outliers[0]?.channel_id}`);
  } catch (e) {
    console.error('[outlier-cache] Error caching outliers:', e);
  }
}

// ==================== Niche Search Cache ====================

export async function getCachedNicheSearch(topic: string): Promise<CachedNicheSearch | null> {
  try {
    // Normalize topic for consistent caching
    const normalizedTopic = topic.toLowerCase().trim();

    const { data, error } = await getSupabase()
      .from('cached_niche_searches')
      .select('*')
      .eq('topic', normalizedTopic)
      .gt('expires_at', new Date().toISOString())
      .single();

    if (error || !data) return null;
    return data as CachedNicheSearch;
  } catch (e) {
    console.error('[outlier-cache] Error getting cached niche search:', e);
    return null;
  }
}

export async function cacheNicheSearch(
  topic: string,
  channelIds: string[],
  metrics: CachedNicheSearch['metrics'],
  totalInDatabase: number,
  source: 'tubelab' | 'youtube'
): Promise<void> {
  try {
    const now = new Date();
    const expires = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000); // 3 days (shorter for search)

    const normalizedTopic = topic.toLowerCase().trim();

    await getSupabase()
      .from('cached_niche_searches')
      .upsert({
        topic: normalizedTopic,
        channel_ids: channelIds,
        metrics,
        total_in_database: totalInDatabase,
        source,
        fetched_at: now.toISOString(),
        expires_at: expires.toISOString(),
      }, { onConflict: 'topic' });

    console.log(`[outlier-cache] Cached niche search: "${topic}" (${channelIds.length} channels)`);
  } catch (e) {
    console.error('[outlier-cache] Error caching niche search:', e);
  }
}

// ==================== Cache Stats ====================

export async function getCacheStats(): Promise<{
  channels: number;
  outliers: number;
  nicheSearches: number;
}> {
  try {
    const sb = getSupabase();

    const [channelsRes, outliersRes, searchesRes] = await Promise.all([
      sb.from('cached_channels').select('id', { count: 'exact', head: true }).gt('expires_at', new Date().toISOString()),
      sb.from('cached_outliers').select('video_id', { count: 'exact', head: true }).gt('expires_at', new Date().toISOString()),
      sb.from('cached_niche_searches').select('topic', { count: 'exact', head: true }).gt('expires_at', new Date().toISOString()),
    ]);

    return {
      channels: channelsRes.count || 0,
      outliers: outliersRes.count || 0,
      nicheSearches: searchesRes.count || 0,
    };
  } catch (e) {
    console.error('[outlier-cache] Error getting cache stats:', e);
    return { channels: 0, outliers: 0, nicheSearches: 0 };
  }
}
