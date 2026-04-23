import { useEffect, useState } from "react";
import { Loader2, CheckCircle, XCircle } from "lucide-react";

/**
 * OAuth callback page for YouTube authentication.
 * This page receives the authorization code from Google and
 * posts it back to the parent window (the popup opener).
 */
export default function YouTubeOAuthCallback() {
  const [status, setStatus] = useState<"loading" | "success" | "error">("loading");
  const [message, setMessage] = useState("Processing authentication...");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const state = params.get("state");
    const error = params.get("error");
    const errorDescription = params.get("error_description");

    // Handle error from Google
    if (error) {
      setStatus("error");
      setMessage(errorDescription || error || "Authentication failed");

      // Post error to parent window
      if (window.opener) {
        window.opener.postMessage(
          {
            type: "youtube-oauth-callback",
            error: errorDescription || error || "Authentication failed",
          },
          window.location.origin
        );
      }

      // Close popup after a delay
      setTimeout(() => window.close(), 2000);
      return;
    }

    // Handle missing code
    if (!code) {
      setStatus("error");
      setMessage("No authorization code received");

      if (window.opener) {
        window.opener.postMessage(
          {
            type: "youtube-oauth-callback",
            error: "No authorization code received",
          },
          window.location.origin
        );
      }

      setTimeout(() => window.close(), 2000);
      return;
    }

    // Success - post code back to parent
    setStatus("success");
    setMessage("Authentication successful! Closing...");

    if (window.opener) {
      window.opener.postMessage(
        {
          type: "youtube-oauth-callback",
          code,
          state,
        },
        window.location.origin
      );
    }

    // Close popup after a short delay
    setTimeout(() => window.close(), 1000);
  }, []);

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="text-center space-y-4 p-6">
        {status === "loading" && (
          <>
            <Loader2 className="w-12 h-12 animate-spin text-primary mx-auto" />
            <p className="text-muted-foreground">{message}</p>
          </>
        )}
        {status === "success" && (
          <>
            <CheckCircle className="w-12 h-12 text-green-500 mx-auto" />
            <p className="text-green-600 font-medium">{message}</p>
          </>
        )}
        {status === "error" && (
          <>
            <XCircle className="w-12 h-12 text-destructive mx-auto" />
            <p className="text-destructive font-medium">{message}</p>
          </>
        )}
      </div>
    </div>
  );
}
