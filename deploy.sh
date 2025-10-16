#!/bin/bash

# Otazumi Watch Party Server - Vercel Deployment Script

echo "🚀 Deploying Otazumi Watch Party Server to Vercel..."

# Check if Vercel CLI is installed
if ! command -v vercel &> /dev/null; then
    echo "❌ Vercel CLI is not installed. Please install it first:"
    echo "npm install -g vercel"
    exit 1
fi

# Check if user is logged in to Vercel
if ! vercel whoami &> /dev/null; then
    echo "❌ You are not logged in to Vercel. Please login first:"
    echo "vercel login"
    exit 1
fi

# Deploy to Vercel
echo "📦 Deploying to Vercel..."
vercel --prod

echo ""
echo "✅ Deployment completed!"
echo ""
echo "📋 Next steps:"
echo "1. Go to your Vercel dashboard"
echo "2. Find the watch-party-server project"
echo "3. Go to Settings > Environment Variables"
echo "4. Add the following environment variables:"
echo "   - NODE_ENV: production"
echo "   - ALLOWED_ORIGINS: https://otazumi.netlify.app,https://otazumi.page,https://www.otazumi.page"
echo "   - NEON_DB_URL: [Your NeonDB connection string] (optional)"
echo ""
echo "5. If using NeonDB, run the migration:"
echo "   vercel env pull .env.local"
echo "   npm run migrate"
echo ""
echo "6. Update your frontend to use the new Vercel URL"