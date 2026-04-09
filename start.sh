#!/usr/bin/env bash
set -e

echo ""
echo "  RecallOS - Local AI Memory Layer"
echo "  ================================="
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "  [ERROR] Node.js is not installed. Download it from https://nodejs.org"
    exit 1
fi

# Install dependencies if needed
[ ! -d "node_modules" ]          && echo "  Installing root dependencies..."    && npm install
[ ! -d "backend/node_modules" ]  && echo "  Installing backend dependencies..." && npm --prefix backend install
[ ! -d "frontend/node_modules" ] && echo "  Installing frontend dependencies..."&& npm --prefix frontend install

echo ""
echo "  Starting backend on http://localhost:3001"
echo "  Starting frontend on http://localhost:5173"
echo ""
echo "  Press Ctrl+C to stop both servers."
echo ""

npm run dev
