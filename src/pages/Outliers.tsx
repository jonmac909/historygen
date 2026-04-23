import { OutlierFinderView } from "@/components/OutlierFinderView";
import { toast } from "@/hooks/use-toast";
import { Toaster } from "@/components/ui/toaster";

const Outliers = () => {
  // Handle video selection - copy URL to clipboard and show instructions
  const handleSelectVideo = (videoUrl: string, videoTitle: string) => {
    navigator.clipboard.writeText(videoUrl);
    toast({
      title: "URL Copied!",
      description: `"${videoTitle}" - Paste it in the main app to start generating.`,
    });
  };

  return (
    <div className="min-h-screen bg-background">
      <Toaster />
      <OutlierFinderView
        onSelectVideo={handleSelectVideo}
        // No onBack - this is a standalone page
      />
    </div>
  );
};

export default Outliers;
