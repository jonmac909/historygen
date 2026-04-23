-- Fix incorrect YouTube channel handles in saved_channels
-- These handles were verified by searching YouTube directly

-- Boring History Secrets (68.7K)
UPDATE saved_channels SET input = '@BoringHistorySecrets' WHERE title ILIKE '%Boring History Secrets%';

-- History at Night (47K)
UPDATE saved_channels SET input = '@History_at_Night' WHERE title ILIKE '%History at Night%';

-- Historian Sleepy (187K)
UPDATE saved_channels SET input = '@HistorianSleepy' WHERE title ILIKE '%Historian Sleepy%';

-- Sleepless Historian (672K)
UPDATE saved_channels SET input = '@SleeplessHistorian' WHERE title ILIKE '%Sleepless Historian%';

-- Chilling Lullabies (37.2K)
UPDATE saved_channels SET input = '@Chilling_Lullabies' WHERE title ILIKE '%Chilling Lullabies%';

-- Comfy History (15.9K)
UPDATE saved_channels SET input = '@ComfyHistory101' WHERE title ILIKE '%Comfy History%';

-- Sleepy Time History (31.8K)
UPDATE saved_channels SET input = '@SleepyTimeHistoryYT' WHERE title ILIKE '%Sleepy Time History%';

-- SleepNomad (53K)
UPDATE saved_channels SET input = '@SleepNomad' WHERE title ILIKE '%SleepNomad%';

-- SleepWise / WiseSleep (227K)
UPDATE saved_channels SET input = '@WiseSleep' WHERE title ILIKE '%SleepWise%' OR title ILIKE '%Sleep Wise%';

-- Smarter While You Sleep
UPDATE saved_channels SET input = '@SmarterWhileYouSleep' WHERE title ILIKE '%Smarter While You Sleep%';

-- Slow History For Sleep (27.6K)
UPDATE saved_channels SET input = '@SHFS_ZzZ' WHERE title ILIKE '%Slow History For Sleep%';

-- Blake Stories (11.2K)
UPDATE saved_channels SET input = '@BlakeStoriesYT' WHERE title ILIKE '%Blake Stories%';

-- Night Psalms (10.8K)
UPDATE saved_channels SET input = '@NightPsalms' WHERE title ILIKE '%Night Psalms%';

-- Sleepy History (20.1K)
UPDATE saved_channels SET input = '@SleepyHistoryShow' WHERE title ILIKE '%Sleepy History%' AND title NOT ILIKE '%American%';

-- The Wealth Historian (26.9K)
UPDATE saved_channels SET input = '@the.wealth.historian' WHERE title ILIKE '%Wealth Historian%';

-- Sleepy American History (18.5K)
UPDATE saved_channels SET input = '@SleepyAmericanHistory' WHERE title ILIKE '%Sleepy American History%';

-- Rise and Fall America (17.9K)
UPDATE saved_channels SET input = '@RiseandFallAmericadecline' WHERE title ILIKE '%Rise and Fall America%';

-- Verify updates
SELECT title, input FROM saved_channels ORDER BY title;
