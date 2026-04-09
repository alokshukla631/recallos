@echo off
title RecallOS
echo.
echo  RecallOS - Local AI Memory Layer
echo  =================================
echo.

:: Check Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo  [ERROR] Node.js is not installed. Download it from https://nodejs.org
    pause
    exit /b 1
)

:: Install dependencies if needed
if not exist "node_modules" (
    echo  Installing root dependencies...
    call npm install
)
if not exist "backend\node_modules" (
    echo  Installing backend dependencies...
    call npm --prefix backend install
)
if not exist "frontend\node_modules" (
    echo  Installing frontend dependencies...
    call npm --prefix frontend install
)

echo.
echo  Starting backend on http://localhost:3001
echo  Starting frontend on http://localhost:5173
echo.
echo  Press Ctrl+C to stop both servers.
echo.

call npm run dev
