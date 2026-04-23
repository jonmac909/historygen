import { Router, Request, Response } from 'express';
import { createClient } from '@supabase/supabase-js';

const router = Router();

interface ChannelInput {
  handle: string;
  name: string;
  subscribers: number;
}

function formatSubs(count: number): string {
  if (count >= 1000000) return (count / 1000000).toFixed(1) + 'M';
  if (count >= 1000) return (count / 1000).toFixed(1) + 'K';
  return count.toString();
}

// GET /bulk-channels - List all saved channels
router.get('/', async (req: Request, res: Response) => {
  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseKey) {
      return res.status(500).json({ error: 'Supabase not configured' });
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    const { data, error } = await supabase
      .from('saved_channels')
      .select('id, title, subscriber_count_formatted')
      .order('sort_order', { ascending: true });

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json({ count: data?.length || 0, channels: data });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /bulk-channels - Insert multiple channels at once
router.post('/', async (req: Request, res: Response) => {
  try {
    const channels: ChannelInput[] = req.body.channels;

    if (!channels || !Array.isArray(channels) || channels.length === 0) {
      return res.status(400).json({ error: 'channels array is required' });
    }

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseKey) {
      return res.status(500).json({ error: 'Supabase not configured' });
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    const records = channels.map((ch, i) => ({
      id: ch.handle,
      title: ch.name,
      thumbnail_url: null,
      subscriber_count_formatted: formatSubs(ch.subscribers),
      average_views: 0,
      average_views_formatted: 'N/A',
      input: ch.handle,
      sort_order: i
    }));

    console.log(`[bulk-channels] Inserting ${records.length} channels...`);

    const { data, error } = await supabase
      .from('saved_channels')
      .upsert(records, { onConflict: 'id' });

    if (error) {
      console.error('[bulk-channels] Error:', error);
      return res.status(500).json({ error: error.message });
    }

    console.log(`[bulk-channels] Success! Inserted ${records.length} channels`);
    res.json({ success: true, count: records.length });
  } catch (err: any) {
    console.error('[bulk-channels] Exception:', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /bulk-channels/duplicates - Remove duplicate channels (keep UC IDs, remove @ handles)
router.delete('/duplicates', async (req: Request, res: Response) => {
  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseKey) {
      return res.status(500).json({ error: 'Supabase not configured' });
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    // Get all channels
    const { data: channels, error: fetchError } = await supabase
      .from('saved_channels')
      .select('id, title, input');

    if (fetchError || !channels) {
      return res.status(500).json({ error: fetchError?.message || 'Failed to fetch channels' });
    }

    // Find channels with real YouTube IDs (UC...)
    const realIdChannels = channels.filter(c => c.id.startsWith('UC'));
    const handleChannels = channels.filter(c => c.id.startsWith('@'));

    // Find @ handles that have a corresponding UC channel (by matching title)
    const titlesWithRealIds = new Set(realIdChannels.map(c => c.title.toLowerCase().trim()));

    const duplicateHandles = handleChannels.filter(c =>
      titlesWithRealIds.has(c.title.toLowerCase().trim())
    );

    if (duplicateHandles.length === 0) {
      return res.json({ message: 'No duplicates found', removed: 0 });
    }

    // Delete the duplicate @ handles
    const idsToDelete = duplicateHandles.map(c => c.id);

    const { error: deleteError } = await supabase
      .from('saved_channels')
      .delete()
      .in('id', idsToDelete);

    if (deleteError) {
      return res.status(500).json({ error: deleteError.message });
    }

    console.log(`[bulk-channels] Removed ${idsToDelete.length} duplicate channels`);
    res.json({
      message: `Removed ${idsToDelete.length} duplicate channels`,
      removed: idsToDelete.length,
      removedIds: idsToDelete
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
