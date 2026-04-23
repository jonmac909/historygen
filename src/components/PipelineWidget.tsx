import { Download, Square, CheckSquare } from "lucide-react";
import { Button } from "@/components/ui/button";

interface PipelineWidgetProps {
  emoji: string;
  label: string;
  subtitle: string;
  isApproved: boolean;
  hasDownload?: boolean;
  onClick: () => void;
  onDownload?: () => void;
  onToggleApproval: (e: React.MouseEvent) => void;
}

export function PipelineWidget({
  emoji,
  label,
  subtitle,
  isApproved,
  hasDownload = false,
  onClick,
  onDownload,
  onToggleApproval,
}: PipelineWidgetProps) {
  return (
    <div
      className={`relative flex flex-col items-center p-4 bg-card rounded-xl border transition-all cursor-pointer hover:scale-[1.02] ${
        isApproved
          ? 'border-green-500/50 hover:border-green-500 bg-green-50/50 dark:bg-green-900/10'
          : 'border-border hover:border-primary/20'
      }`}
      onClick={onClick}
    >
      {/* Emoji */}
      <span className="text-3xl mb-2">{emoji}</span>

      {/* Label */}
      <p className="font-medium text-foreground text-sm">{label}</p>

      {/* Subtitle */}
      <p className="text-xs text-muted-foreground mt-0.5 text-center">{subtitle}</p>

      {/* Action buttons - absolute positioned at bottom */}
      <div className="flex items-center gap-1 mt-3">
        {hasDownload && onDownload && (
          <Button
            variant="ghost"
            size="icon"
            onClick={(e) => {
              e.stopPropagation();
              onDownload();
            }}
            className="h-7 w-7 text-muted-foreground hover:text-foreground"
            title="Download"
          >
            <Download className="w-4 h-4" />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          onClick={onToggleApproval}
          className={`h-7 w-7 rounded-md ${
            isApproved
              ? 'text-green-600 hover:text-green-700 dark:text-green-400'
              : 'text-muted-foreground hover:text-foreground'
          }`}
          title={isApproved ? 'Mark as not approved' : 'Mark as approved'}
        >
          {isApproved ? (
            <CheckSquare className="w-4 h-4" />
          ) : (
            <Square className="w-4 h-4" />
          )}
        </Button>
      </div>
    </div>
  );
}
