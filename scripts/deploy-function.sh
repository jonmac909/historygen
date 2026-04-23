#!/bin/bash
# Deployment script for Supabase function

echo "To deploy the function, you need a Supabase access token."
echo ""
echo "Get your token:"
echo "1. Go to: https://supabase.com/dashboard/account/tokens"
echo "2. Generate a new token"
echo "3. Run: export SUPABASE_ACCESS_TOKEN='your-token-here'"
echo "4. Then run: npx supabase link --project-ref crrgvodgeqayidluzqwz"
echo "5. Finally run: npx supabase functions deploy generate-audio"
echo ""
echo "Or run this script with the token:"
echo "  SUPABASE_ACCESS_TOKEN='your-token' ./deploy-function.sh deploy"

if [ "$1" = "deploy" ]; then
    if [ -z "$SUPABASE_ACCESS_TOKEN" ]; then
        echo "Error: SUPABASE_ACCESS_TOKEN not set"
        exit 1
    fi
    
    echo "Linking project..."
    npx supabase link --project-ref crrgvodgeqayidluzqwz
    
    echo "Deploying generate-audio function..."
    npx supabase functions deploy generate-audio
    
    echo "✓ Deployment complete!"
fi
