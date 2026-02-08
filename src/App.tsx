import { useState, useEffect } from "react";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import Index from "./pages/Index";
import Outliers from "./pages/Outliers";
import AutoPoster from "./pages/AutoPoster";
import VideoAnalysis from "./pages/VideoAnalysis";
import VideoEditor from "./pages/VideoEditor";
import NotFound from "./pages/NotFound";
import YouTubeOAuthCallback from "./pages/YouTubeOAuthCallback";

const queryClient = new QueryClient();

const PASSWORD = "9090";

function LoginScreen({ onLogin }: { onLogin: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (password === PASSWORD) {
      localStorage.setItem("authenticated", "true");
      onLogin();
    } else {
      setError(true);
      setPassword("");
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="w-full max-w-sm p-6">
        <h1 className="text-2xl font-semibold text-center mb-6">AUTO AI GEN</h1>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <input
              type="password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setError(false);
              }}
              placeholder="Enter password"
              className="w-full px-4 py-2 border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-primary"
              autoFocus
            />
          </div>
          {error && (
            <p className="text-sm text-destructive">Incorrect password</p>
          )}
          <button
            type="submit"
            className="w-full py-2 px-4 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors"
          >
            Enter
          </button>
        </form>
      </div>
    </div>
  );
}

const App = () => {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null);

  useEffect(() => {
    const auth = localStorage.getItem("authenticated");
    setIsAuthenticated(auth === "true");
  }, []);

  if (isAuthenticated === null) {
    return null; // Loading state
  }

  // OAuth callback must be accessible without authentication (it's a popup)
  const isOAuthCallback = window.location.pathname.startsWith("/oauth/");

  if (!isAuthenticated && !isOAuthCallback) {
    return <LoginScreen onLogin={() => setIsAuthenticated(true)} />;
  }

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <Sonner />
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<Index />} />
            <Route path="/outliers" element={<Outliers />} />
            <Route path="/auto-poster" element={<AutoPoster />} />
            <Route path="/video-analysis" element={<VideoAnalysis />} />
            <Route path="/video-editor" element={<VideoEditor />} />
            <Route path="/oauth/youtube/callback" element={<YouTubeOAuthCallback />} />
            {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
            <Route path="*" element={<NotFound />} />
          </Routes>
        </BrowserRouter>
      </TooltipProvider>
    </QueryClientProvider>
  );
};

export default App;
// Trigger Vercel deployment - Sun Feb  8 07:05:27 PST 2026
