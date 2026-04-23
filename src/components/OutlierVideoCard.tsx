import { useState } from "react";
import { OutlierVideo } from "@/lib/api";

interface OutlierVideoCardProps {
  video: OutlierVideo;
  averageViews: number;
  averageViewsFormatted: string;
  channelTitle: string;
  subscriberCountFormatted: string;
  onClick?: () => void;
}

function formatNumber(num: number): string {
  if (num >= 1000000) {
    return (num / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  }
  if (num >= 1000) {
    return (num / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  }
  return num.toString();
}

function formatTimeAgo(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays < 1) return 'today';
  if (diffDays === 1) return 'yesterday';
  if (diffDays < 7) return `${diffDays} days ago`;
  if (diffDays < 30) {
    const weeks = Math.floor(diffDays / 7);
    return weeks === 1 ? '1 week ago' : `${weeks} weeks ago`;
  }
  if (diffDays < 365) {
    const months = Math.floor(diffDays / 30);
    return months === 1 ? 'about 1 month' : `about ${months} months`;
  }
  const years = Math.floor(diffDays / 365);
  return years === 1 ? 'about 1 year' : `about ${years} years`;
}

function formatPSTTime(dateString: string): string {
  const date = new Date(dateString);
  return date.toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

function getOutlierBadgeStyle(multiplier: number): string {
  if (multiplier >= 5) return 'bg-red-500 text-white';
  if (multiplier >= 3) return 'bg-orange-400 text-white';
  if (multiplier >= 2) return 'bg-yellow-400 text-gray-900';
  return 'bg-gray-400 text-white';
}

export function OutlierVideoCard({ video, averageViewsFormatted, channelTitle, subscriberCountFormatted, onClick }: OutlierVideoCardProps) {
  const [imageError, setImageError] = useState(false);
  const viewsFormatted = formatNumber(video.viewCount);
  const timeAgo = formatTimeAgo(video.publishedAt);
  const pstTime = formatPSTTime(video.publishedAt);
  const outlierBadgeStyle = getOutlierBadgeStyle(video.outlierMultiplier);

  // Don't render if thumbnail failed to load (deleted/private video)
  if (imageError) {
    return null;
  }

  const handleTitleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    window.open(`https://youtube.com/watch?v=${video.videoId}`, '_blank');
  };

  return (
    <div className="group">
      {/* Thumbnail with badges - click to use video */}
      <div
        className="relative aspect-video rounded-xl overflow-hidden mb-2 bg-gray-200 cursor-pointer"
        onClick={onClick}
      >
        <img
          src={video.thumbnailUrl}
          alt={video.title}
          className="w-full h-full object-cover"
          onError={() => setImageError(true)}
        />
        {/* Duration badge */}
        <span className="absolute bottom-2 left-2 px-1.5 py-0.5 text-xs font-medium bg-black/80 text-white rounded">
          {video.durationFormatted}
        </span>
      </div>

      {/* Video info */}
      <div className="space-y-1">
        {/* Title - click to open on YouTube */}
        <h3
          className="text-sm font-medium text-gray-900 line-clamp-2 hover:text-blue-600 transition-colors leading-snug cursor-pointer"
          onClick={handleTitleClick}
        >
          {video.title}
        </h3>

        {/* Channel info row */}
        <div className="text-xs text-gray-500">
          <span className="text-blue-600">@{channelTitle.replace(/\s+/g, '')}</span>
          <span className="mx-1">•</span>
          <span>{subscriberCountFormatted} subs</span>
        </div>

        {/* Time ago + PST time */}
        <div className="text-xs text-gray-500">
          {timeAgo} <span className="text-gray-400">({pstTime} PST)</span>
        </div>

        {/* Outlier badge + views comparison row */}
        <div className="flex items-center gap-2 pt-1">
          <span className={`px-2 py-0.5 text-xs font-bold rounded-full ${outlierBadgeStyle}`}>
            {video.outlierMultiplier.toFixed(2)}x
          </span>
          <span className="text-xs text-gray-600">
            {viewsFormatted} views vs {averageViewsFormatted} avg
          </span>
        </div>
      </div>
    </div>
  );
}
